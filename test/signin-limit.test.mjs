// Run: node --test test/signin-limit.test.mjs
// Sign-in email limit (src/core/signin-limit.ts): the pack middleware caps the sign-in links EmDash's
// magic-link route emails per address (3 per 15 minutes), counted in EmDash's _emdash_rate_limits table.
// Over the limit, the request still goes on to EmDash, as one for an address that has no account
// (<16 hex>@held.invalid): the pack writes no answer and adds no pause of its own. There is no cap on
// all addresses together (no `coywolf-all:` row is ever written). EmDash's real schema, rate limiter and
// route, on Astro's real middleware runtime, are checked in test/emdash-contract.test.mjs.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: "data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { globalThis.__waitUntil?.push(p); }; export const cache = {};",
				shortCircuit: true,
			};
		}
		if (specifier === "./modules.js" && context.parentURL?.endsWith("/src/middleware.ts")) {
			return { url: "data:text/javascript,export const MIDDLEWARE = [];", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const limit = await import("../src/core/signin-limit.ts");
const { coywolfPack } = await import("../src/middleware.ts");
const { EMAIL_LIMIT, HELD_EMAIL_DOMAIN, SIGNIN_BODY_MAX, emailKey, signInHeldRequest, windowStart } = limit;

const ADMIN = "admin@example.com";
const SEND = "/_emdash/api/auth/magic-link/send";
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0); // on a window boundary of the limit

/** A D1Database over node:sqlite with the tables the limits use (as EmDash's migrations create them). */
function d1(users = [ADMIN]) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
		CREATE TABLE _emdash_rate_limits (key TEXT NOT NULL, "window" TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, CONSTRAINT pk_rate_limits PRIMARY KEY (key, "window"));
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);
	users.forEach((email, i) => sqlite.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(`u${i}`, email));
	const statement = (sql, params = []) => ({
		bind: (...p) => statement(sql, p),
		all: async () => ({ results: sqlite.prepare(sql).all(...params), success: true, meta: {} }),
		first: async () => sqlite.prepare(sql).get(...params) ?? null,
		run: async () => ({ results: [], success: true, meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
	});
	return { sqlite, prepare: (sql) => statement(sql), batch: async (statements) => Promise.all(statements.map((s) => s.all())) };
}
/** Every row of the table. No row for all addresses together may ever be there: the per-address rows are the only ones. */
const rows = (db) => {
	const all = db.sqlite.prepare(`SELECT key, "window", count FROM _emdash_rate_limits ORDER BY key, "window"`).all().map((row) => ({ ...row }));
	for (const row of all) assert.match(row.key, /^coywolf-email:[0-9a-f]{64}:magic-link\/send$/, `only per-address rows are written, not ${row.key}`);
	return all;
};

/** A sign-in email request, as EmDash's sign-in page sends it. */
function sendRequest(body, { path = SEND, method = "POST", headers } = {}) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Request(`https://example.com${path}`, {
		method,
		body: method === "GET" ? undefined : text,
		headers: headers ?? { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).byteLength) },
	});
}

const options = (now = T0) => ({ now: () => now });
const check = (db, request, now) => signInHeldRequest(request, new URL(request.url).pathname, db, options(now));
const HELD_EMAIL = /^[0-9a-f]{16}@held\.invalid$/;

/**
 * A held request: the one EmDash gets in the original's place. The same URL, method and headers (less
 * Content-Length), and a JSON body naming an address nobody has. Returns that body.
 */
async function assertHeld(held, original) {
	assert.ok(held instanceof Request, "the request was held: EmDash gets another in its place");
	assert.notEqual(held, original);
	assert.equal(held.url, original.url);
	assert.equal(held.method, original.method);
	const headers = [...original.headers].filter(([name]) => name !== "content-length");
	assert.deepEqual([...held.headers], headers, "the original's headers, less Content-Length");
	const body = await held.json();
	assert.match(body.email, HELD_EMAIL, "an address no user can have");
	return body;
}
/** Sends a request through the check and asserts it was held. */
async function assertHolds(db, request, now) {
	return assertHeld(await check(db, request, now), request);
}

test("under the per-address limit, requests go on to EmDash unchanged; the next one goes on as a request for an address nobody has", async () => {
	const db = d1();
	for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal(await check(db, sendRequest({ email: ADMIN })), null, `request ${i + 1}`);
	const original = sendRequest({ email: ADMIN });
	const held = await check(db, original);
	assert.deepEqual(Object.keys(await assertHeld(held, original)), ["email"]);
	assert.equal(original.bodyUsed, false, "the original's body is left alone");
	assert.equal(HELD_EMAIL_DOMAIN, "held.invalid", "a reserved top-level domain (RFC 2606)");
	assert.notEqual(limit.heldEmail(), limit.heldEmail(), "random each time");
	// No answer of the pack's own, and no pause: what EmDash does with the held request is the whole answer.
	assert.equal(limit.signInSentResponse, undefined);
	assert.equal(limit.signInLimitResponse, undefined);
	assert.equal(limit.SIGNIN_SENT_MESSAGE, undefined);
	// Counted as EmDash counts: the key, the window start, and every request for the address (held ones too). One row, and no other.
	assert.deepEqual(rows(db), [{ key: await emailKey(ADMIN), window: windowStart(T0, 900), count: 4 }]);
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _emdash_rate_limits WHERE key LIKE 'coywolf-all:%'").get().n, 0, "no row for all addresses together");
	assert.equal(limit.ALL_KEY, undefined);
	assert.equal(limit.ALL_LIMIT, undefined);
	assert.match(await emailKey(ADMIN), /^coywolf-email:[0-9a-f]{64}:magic-link\/send$/);
	assert.ok(!JSON.stringify(rows(db)).includes("example.com"), "the address itself is never stored");
	// A new 15-minute window lets the address through again.
	assert.equal(await check(db, sendRequest({ email: ADMIN }), T0 + EMAIL_LIMIT.windowSeconds * 1000), null);
});

test("the address is lowercased, so spellings of one address share its limit", async () => {
	const db = d1();
	for (const email of [ADMIN, "Admin@Example.com", "ADMIN@EXAMPLE.COM"]) assert.equal(await check(db, sendRequest({ email })), null);
	await assertHolds(db, sendRequest({ email: "admin@EXAMPLE.com" }));
});

test("a held request keeps everything but the address: the other fields, the headers, cf and the abort signal", async () => {
	const db = d1();
	for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal(await check(db, sendRequest({ email: ADMIN })), null);
	const abort = new AbortController();
	const text = `{"redirect":"/_emdash/admin/","email":"${ADMIN}","nested":{"a":[1,2]},"__proto__":{"email":"x@example.com"}}`;
	const original = new Request(`https://example.com${SEND}?next=1`, {
		method: "POST",
		body: text,
		signal: abort.signal,
		headers: { "content-type": "application/json", "content-length": String(text.length), "cf-connecting-ip": "203.0.113.9", cookie: "a=b", origin: "https://example.com", "x-forwarded-for": "203.0.113.9" },
	});
	// On Workers the request carries `cf`; EmDash only believes CF-Connecting-IP (for its IP limit) on a request that has it.
	const cf = { colo: "TEST" };
	Object.defineProperty(original, "cf", { value: cf });
	const held = await check(db, original);
	const body = await assertHeld(held, original);
	assert.deepEqual(Object.keys(body).sort(), ["__proto__", "email", "nested", "redirect"], "the original's fields, with the email replaced");
	assert.equal(body.redirect, "/_emdash/admin/");
	assert.deepEqual(body.nested, { a: [1, 2] });
	assert.equal(held.headers.get("content-length"), null);
	assert.equal(held.headers.get("cf-connecting-ip"), "203.0.113.9");
	assert.equal(held.cf, cf);
	assert.equal(held.signal.aborted, false);
	abort.abort();
	assert.equal(held.signal.aborted, true, "the held request is aborted with the original");
});

test("a user's address and any other cost the same: one statement each, and no timer of the pack's", async () => {
	const db = d1();
	const statements = [];
	const counting = { ...db, prepare: (sql) => (statements.push(sql.replace(/\s+/g, " ").trim()), db.prepare(sql)) };
	const timers = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...rest) => (timers.push(ms), realSetTimeout(fn, ms, ...rest));
	try {
		for (let i = 0; i < EMAIL_LIMIT.max + 2; i++) await check(counting, sendRequest({ email: ADMIN }));
		const forUser = statements.splice(0);
		for (let i = 0; i < EMAIL_LIMIT.max + 2; i++) await check(counting, sendRequest({ email: "nobody@example.com" }));
		assert.equal(forUser.length, EMAIL_LIMIT.max + 2, "one statement per request, held or not");
		assert.deepEqual(statements, forUser, "the same statements for an address that isn't a user's");
		assert.deepEqual(timers, [], "the pack never pauses: a held request's pause is EmDash's own, for an unknown address");
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	assert.equal(rows(db).length, 1, "and only the user's address is counted");
});

test("a padded address isn't trimmed: it matches no user, isn't counted, and goes on to EmDash (which answers 400), for a user as for anyone", async () => {
	// EmDash's schema refuses these. Trimming would hold a user's 4th with a 200 while a non-user's stayed 400: a way to tell who has an account.
	const db = d1();
	assert.equal(limit.requestedEmail(JSON.stringify({ email: " Admin@Example.com " })), " admin@example.com ");
	// "admin@exam\u212Aple…" has no user here, so the last one uses a user with a k: the Kelvin sign must not fold into it.
	db.sqlite.prepare("INSERT INTO users (id, email) VALUES ('k', 'mark@example.com')").run();
	for (const email of [` ${ADMIN}`, `${ADMIN} `, `${ADMIN}\n`, `\t${ADMIN}`, " nobody@example.com", "mar\u212A@example.com"]) {
		for (let i = 0; i < EMAIL_LIMIT.max + 2; i++) assert.equal(await check(db, sendRequest({ email })), null, `${JSON.stringify(email)}, request ${i + 1}`);
	}
	assert.deepEqual(rows(db), [], "nothing counted");
	// The address itself still has its whole limit.
	for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal(await check(db, sendRequest({ email: ADMIN })), null);
	await assertHolds(db, sendRequest({ email: ADMIN }));
});

test("each address has its own limit and nothing else: no number of users' requests holds another user's, and no row for all addresses is written", async () => {
	// 30 users, each at their limit in one window (90 requests that go on): with a cap on all addresses together, the later ones would be held.
	const users = Array.from({ length: 30 }, (_, i) => `user${i}@example.com`);
	const db = d1([...users, "editor@example.com"]);
	for (const [n, email] of users.entries()) for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal(await check(db, sendRequest({ email }), T0 + n * 1000 + i), null, `${email}, request ${i + 1}`);
	// One address far over its own limit: held, and still only its own row grows.
	for (let i = 0; i < 25; i++) await assertHolds(db, sendRequest({ email: users[0] }), T0 + 60_000 + i);
	// Another user's first request, in the same window, goes on to EmDash.
	assert.equal(await check(db, sendRequest({ email: "editor@example.com" }), T0 + 120_000), null);
	const counted = rows(db); // asserts every key is a per-address one
	assert.equal(counted.length, users.length + 1, "one row per address");
	assert.equal(counted.find((row) => row.key.startsWith("coywolf-all")), undefined);
	assert.equal(counted.reduce((sum, row) => sum + row.count, 0), users.length * EMAIL_LIMIT.max + 25 + 1);
	// Later windows in the hour: the address gets its limit again each time (nothing adds up across windows).
	for (let w = 1; w < 4; w++) {
		const at = T0 + w * EMAIL_LIMIT.windowSeconds * 1000;
		for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal(await check(db, sendRequest({ email: users[0] }), at + i), null, `window ${w}, request ${i + 1}`);
		await assertHolds(db, sendRequest({ email: users[0] }), at + 10);
	}
	rows(db);
});

test("an address that isn't a user's isn't counted", async () => {
	const db = d1();
	for (let i = 0; i < 40; i++) assert.equal(await check(db, sendRequest({ email: `nobody${i}@example.com` })), null);
	for (let i = 0; i < 5; i++) assert.equal(await check(db, sendRequest({ email: "nobody@example.com" })), null);
	assert.deepEqual(rows(db), []);
	assert.equal(await check(db, sendRequest({ email: ADMIN })), null, "the admin's first request still goes on");
});

test("bodies the pack can't read as a sign-in request go on to EmDash, uncounted", async () => {
	const db = d1();
	for (const body of ["{not json", "", "null", "[]", JSON.stringify({ email: 5 }), JSON.stringify({ address: ADMIN }), JSON.stringify({ email: "admin" })]) {
		assert.equal(await check(db, sendRequest(body)), null, body);
	}
	assert.deepEqual(rows(db), []);
});

test("a body too big to be a sign-in request is held the same way, uncounted, whoever it names: padding can't skip the limits", async () => {
	const db = d1();
	// Declared too big: not read at all (EmDash's schema ignores extra fields, so padding would otherwise reach it).
	// EmDash gets the address nobody has and nothing else.
	const padded = JSON.stringify({ email: ADMIN, pad: "x".repeat(SIGNIN_BODY_MAX) });
	assert.deepEqual(Object.keys(await assertHolds(db, sendRequest(padded))), ["email"]);
	// The same for an address that isn't a user's, for a body that isn't JSON, and without a database: nothing about the body is looked at.
	assert.deepEqual(Object.keys(await assertHolds(db, sendRequest(padded.replace(ADMIN, "nobody@example.com")))), ["email"]);
	assert.deepEqual(Object.keys(await assertHolds(db, sendRequest("x".repeat(SIGNIN_BODY_MAX + 1)))), ["email"]);
	assert.deepEqual(Object.keys(await assertHolds(undefined, sendRequest(padded))), ["email"]);
	// No Content-Length (a chunked upload): read up to the limit, then held.
	const stream = (text) => new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) });
	const chunked = (text) => new Request(`https://example.com${SEND}`, { method: "POST", body: stream(text), duplex: "half", headers: { "content-type": "application/json" } });
	assert.equal(chunked(padded).headers.get("content-length"), null);
	assert.deepEqual(Object.keys(await assertHolds(db, chunked(padded))), ["email"]);
	assert.deepEqual(rows(db), [], "nothing counted");
	// A small chunked request is counted like any other.
	assert.equal(await check(db, chunked(JSON.stringify({ email: ADMIN }))), null);
	assert.deepEqual(rows(db), [{ key: await emailKey(ADMIN), window: windowStart(T0, 900), count: 1 }]);
});

test("EmDash's route still reads the body after the check", async () => {
	const db = d1();
	const request = sendRequest({ email: ADMIN });
	assert.equal(await check(db, request), null);
	assert.deepEqual(await request.json(), { email: ADMIN });
});

test("a body that's already been read fails open: the request goes on to EmDash, uncounted", async () => {
	const db = d1();
	const used = sendRequest({ email: ADMIN });
	await used.text();
	assert.equal(used.bodyUsed, true);
	assert.equal(await check(db, used), null);
	// A locked body (a reader held on it) too.
	const locked = sendRequest({ email: ADMIN });
	locked.body.getReader();
	assert.equal(await check(db, locked), null);
	// And a request whose clone() throws anything at all.
	const broken = sendRequest({ email: ADMIN });
	broken.clone = () => {
		throw new Error("no clone");
	};
	assert.equal(await check(db, broken), null);
	assert.deepEqual(rows(db), []);
});

test("a database error fails open (the request goes on to EmDash), logged once per isolate", async () => {
	limit.resetSignInLimitLog();
	const logged = [];
	const original = console.error;
	console.error = (...args) => logged.push(args);
	try {
		// The count can't be written.
		const broken = { prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error("D1_ERROR: no such table")) }) }) };
		assert.equal(await check(broken, sendRequest({ email: ADMIN })), null);
		assert.equal(await check(broken, sendRequest({ email: ADMIN })), null);
		const throws = {
			prepare: () => {
				throw new Error("D1 down");
			},
		};
		assert.equal(await check(throws, sendRequest({ email: ADMIN })), null);
		assert.equal(logged.length, 1, "one log line for three failures");
		assert.match(String(logged[0][0]), /sign-in email limit/);
		// No database binding: nothing to count with, nothing logged.
		assert.equal(await check(undefined, sendRequest({ email: ADMIN })), null);
		assert.equal(logged.length, 1);
	} finally {
		console.error = original;
		limit.resetSignInLimitLog();
	}
});

test("only POSTs to EmDash's send route are checked, however Astro would route the path", async () => {
	assert.equal(limit.isSignInSend("POST", SEND), true);
	assert.equal(limit.isSignInSend("POST", `${SEND}/`), true, "trailing slash (Astro's default trailingSlash routes it)");
	assert.equal(limit.isSignInSend("POST", "/_emdash/api/auth/magic-link/sen%64"), true, "encoded");
	assert.equal(limit.isSignInSend("POST", "/_emdash/api/auth/magic-link/sen%2564"), true, "encoded twice");
	assert.equal(limit.isSignInSend("POST", "/_emdash//api/auth/magic-link/send"), true);
	assert.equal(limit.isSignInSend("GET", SEND), false);
	assert.equal(limit.isSignInSend("POST", "/_emdash/api/auth/magic-link/verify"), false);
	assert.equal(limit.isSignInSend("POST", "/_emdash/api/auth/signup/request"), false);
	assert.equal(limit.isSignInSend("POST", "/_emdash/api/auth/magic-link/send-other"), false);
	assert.equal(limit.isSignInSend("POST", "/%"), false, "bad encoding doesn't throw");
	// Other requests are never read or counted.
	const db = d1();
	let read = false;
	const other = new Request("https://example.com/_emdash/api/settings", { method: "POST", body: JSON.stringify({ email: ADMIN }) });
	const clone = other.clone.bind(other);
	other.clone = () => ((read = true), clone());
	assert.equal(await signInHeldRequest(other, "/_emdash/api/settings", db, options()), null);
	assert.equal(read, false);
	assert.deepEqual(rows(db), []);
});

// ── In the middleware ────────────────────────────────────────────

function middlewareContext(request) {
	return { url: new URL(request.url), request, cache: undefined, locals: {}, site: undefined };
}

test("the middleware hands EmDash a held sign-in request in the original's place, answers with whatever EmDash answers, and lets every other request through", async () => {
	const db = d1();
	globalThis.__testEnv = { DB: db };
	globalThis.__waitUntil = [];
	// EmDash's route, as Astro calls it at the end of the chain: it reads the context's request.
	const seen = [];
	const route = (context, answer) => async (...args) => {
		assert.deepEqual(args, [], "next() is called without a request: Astro would route that again");
		seen.push(await context.request.json());
		return answer();
	};
	const sent = () => Response.json({ success: true, data: { success: true, message: "sent" } }, { headers: { "Cache-Control": "private, no-store" } });
	const send = async (email, answer = sent) => {
		const context = middlewareContext(sendRequest({ email }));
		return coywolfPack()(context, route(context, answer));
	};
	for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal((await send(ADMIN)).status, 200);
	assert.deepEqual(seen, Array(EMAIL_LIMIT.max).fill({ email: ADMIN }), "under the limit, EmDash gets the request as sent");
	// Over it: EmDash's route still runs, once, with an address nobody has, and its answer is the answer.
	const unavailable = () => Response.json({ error: { code: "EMAIL_NOT_CONFIGURED", message: "Email is not configured." } }, { status: 503, headers: { "Cache-Control": "private, no-store", "X-From": "emdash" } });
	const held = await send(ADMIN, unavailable);
	assert.equal(seen.length, EMAIL_LIMIT.max + 1, "EmDash's route ran once more");
	assert.match(seen.at(-1).email, HELD_EMAIL);
	assert.equal(held.status, 503, "EmDash's status, not one of the pack's");
	assert.equal(held.headers.get("x-from"), "emdash");
	assert.deepEqual(await held.json(), { error: { code: "EMAIL_NOT_CONFIGURED", message: "Email is not configured." } });
	// Someone without an account gets the same from the same route, with their own address.
	const other = await send("nobody@example.com", unavailable);
	assert.equal(other.status, 503);
	assert.deepEqual(seen.at(-1), { email: "nobody@example.com" });
	assert.deepEqual([...other.headers], [...held.headers]);
	// Another route with the same body, and a page: on to the site as before, with their own requests.
	let others = 0;
	const verify = middlewareContext(sendRequest({ email: ADMIN }, { path: "/_emdash/api/auth/magic-link/verify" }));
	const verifyRequest = verify.request;
	await coywolfPack()(verify, async () => (others++, new Response("ok")));
	assert.equal(verify.request, verifyRequest);
	await coywolfPack()(middlewareContext(new Request("https://example.com/about/")), async () => (others++, new Response("<p>page</p>", { headers: { "content-type": "text/html" } })));
	assert.equal(others, 2);
	await Promise.allSettled(globalThis.__waitUntil);
});

test("a context that can't be given a request fails open: the request goes on as sent, logged", async () => {
	const db = d1();
	globalThis.__testEnv = { DB: db };
	globalThis.__waitUntil = [];
	const logged = [];
	const original = console.error;
	console.error = (...args) => logged.push(args);
	try {
		let last;
		for (let i = 0; i < EMAIL_LIMIT.max + 1; i++) {
			const request = sendRequest({ email: ADMIN });
			const context = Object.defineProperty(middlewareContext(request), "request", { get: () => request });
			const response = await coywolfPack()(context, async () => Response.json(await context.request.json()));
			last = await response.json();
		}
		assert.deepEqual(last, { email: ADMIN });
		assert.equal(logged.length, 1);
		assert.match(String(logged[0][0]), /sign-in email limit/);
	} finally {
		console.error = original;
	}
	await Promise.allSettled(globalThis.__waitUntil);
});

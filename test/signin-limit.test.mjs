// Run: node --test test/signin-limit.test.mjs
// Sign-in email limits (src/core/signin-limit.ts): the pack middleware caps the sign-in links EmDash's
// magic-link route emails, per address (3 per 15 minutes) and for every address (20 an hour), counted in
// EmDash's _emdash_rate_limits table. Over a limit, the request gets EmDash's own "sent" answer without
// reaching EmDash. EmDash's real schema and rate limiter are checked in test/emdash-contract.test.mjs.
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
const { ALL_KEY, ALL_LIMIT, EMAIL_LIMIT, SIGNIN_BODY_MAX, SIGNIN_SENT_MESSAGE, emailKey, signInLimitResponse, windowStart } = limit;

const ADMIN = "admin@example.com";
const SEND = "/_emdash/api/auth/magic-link/send";
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0); // on a window boundary of both limits

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
const rows = (db) => db.sqlite.prepare(`SELECT key, "window", count FROM _emdash_rate_limits ORDER BY key`).all().map((row) => ({ ...row }));

/** A sign-in email request, as EmDash's sign-in page sends it. */
function sendRequest(body, { path = SEND, method = "POST", headers } = {}) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Request(`https://example.com${path}`, {
		method,
		body: method === "GET" ? undefined : text,
		headers: headers ?? { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).byteLength) },
	});
}

let pauses = 0;
const options = (now = T0) => ({ now: () => now, pause: async () => void pauses++ });
const check = (db, request, now) => signInLimitResponse(request, new URL(request.url).pathname, db, options(now));

async function assertSent(response) {
	assert.ok(response, "the request was held");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
	assert.deepEqual(await response.json(), { success: true, data: { success: true, message: SIGNIN_SENT_MESSAGE } });
}

test("under the per-address limit, requests go on to EmDash; the next one gets EmDash's sent answer instead", async () => {
	const db = d1();
	pauses = 0;
	for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal(await check(db, sendRequest({ email: ADMIN })), null, `request ${i + 1}`);
	assert.equal(pauses, 0, "requests that go on aren't paused");
	await assertSent(await check(db, sendRequest({ email: ADMIN })));
	assert.equal(pauses, 1, "a held request is paused, as EmDash pauses for an unknown address");
	// Counted as EmDash counts: the key, the window start, and every request (held ones too).
	assert.deepEqual(rows(db), [
		{ key: ALL_KEY, window: windowStart(T0, 3600), count: 4 },
		{ key: await emailKey(ADMIN), window: windowStart(T0, 900), count: 4 },
	]);
	assert.match(await emailKey(ADMIN), /^coywolf-email:[0-9a-f]{64}:magic-link\/send$/);
	assert.ok(!JSON.stringify(rows(db)).includes("example.com"), "the address itself is never stored");
	// A new 15-minute window lets the address through again.
	assert.equal(await check(db, sendRequest({ email: ADMIN }), T0 + EMAIL_LIMIT.windowSeconds * 1000), null);
});

test("the address is trimmed and lowercased, so spellings of one address share its limit", async () => {
	const db = d1();
	for (const email of [ADMIN, " Admin@Example.com", "ADMIN@EXAMPLE.COM "]) assert.equal(await check(db, sendRequest({ email })), null);
	await assertSent(await check(db, sendRequest({ email: "admin@EXAMPLE.com" })));
});

test("over the hourly cap on every address, a request for any user is held", async () => {
	const users = Array.from({ length: ALL_LIMIT.max + 1 }, (_, i) => `user${i}@example.com`);
	const db = d1(users);
	for (let i = 0; i < ALL_LIMIT.max; i++) assert.equal(await check(db, sendRequest({ email: users[i] }), T0 + i * 1000), null, `user ${i}`);
	// A user with no requests yet, still in the hour.
	await assertSent(await check(db, sendRequest({ email: users[ALL_LIMIT.max] }), T0 + 30 * 60_000));
	// The next hour.
	assert.equal(await check(db, sendRequest({ email: users[ALL_LIMIT.max] }), T0 + ALL_LIMIT.windowSeconds * 1000), null);
});

test("an address that isn't a user's isn't counted: made-up addresses can't use up the hourly cap", async () => {
	const db = d1();
	for (let i = 0; i < ALL_LIMIT.max * 2; i++) assert.equal(await check(db, sendRequest({ email: `nobody${i}@example.com` })), null);
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

test("a body too big to be a sign-in request is held, uncounted: padding can't skip the limits", async () => {
	const db = d1();
	pauses = 0;
	// Declared too big: not read at all (EmDash's schema ignores extra fields, so padding would otherwise reach it).
	const padded = JSON.stringify({ email: ADMIN, pad: "x".repeat(SIGNIN_BODY_MAX) });
	await assertSent(await check(db, sendRequest(padded)));
	// No Content-Length (a chunked upload): read up to the limit, then held.
	const stream = (text) => new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) });
	const chunked = (text) => new Request(`https://example.com${SEND}`, { method: "POST", body: stream(text), duplex: "half", headers: { "content-type": "application/json" } });
	assert.equal(chunked(padded).headers.get("content-length"), null);
	await assertSent(await check(db, chunked(padded)));
	assert.equal(pauses, 2);
	assert.deepEqual(rows(db), [], "nothing counted");
	// A small chunked request is counted like any other.
	assert.equal(await check(db, chunked(JSON.stringify({ email: ADMIN }))), null);
	assert.equal(rows(db).length, 2);
});

test("EmDash's route still reads the body after the check", async () => {
	const db = d1();
	const request = sendRequest({ email: ADMIN });
	assert.equal(await check(db, request), null);
	assert.deepEqual(await request.json(), { email: ADMIN });
});

test("a database error fails open (the request goes on to EmDash), logged once per isolate", async () => {
	limit.resetSignInLimitLog();
	const logged = [];
	const original = console.error;
	console.error = (...args) => logged.push(args);
	try {
		const broken = { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }), all: async () => ({ results: [] }) }) }), batch: async () => Promise.reject(new Error("D1_ERROR: no such table")) };
		assert.equal(await check(broken, sendRequest({ email: ADMIN })), null);
		assert.equal(await check(broken, sendRequest({ email: ADMIN })), null);
		const lookupFails = { prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error("D1 down")) }) }) };
		assert.equal(await check(lookupFails, sendRequest({ email: ADMIN })), null);
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
	assert.equal(await signInLimitResponse(other, "/_emdash/api/settings", db, options()), null);
	assert.equal(read, false);
	assert.deepEqual(rows(db), []);
});

// ── In the middleware ────────────────────────────────────────────

function middlewareContext(request) {
	return { url: new URL(request.url), request, cache: undefined, locals: {}, site: undefined };
}

test("the middleware answers a held sign-in request itself and lets every other request through", async () => {
	const db = d1();
	globalThis.__testEnv = { DB: db };
	globalThis.__waitUntil = [];
	let reached = 0;
	const emdash = async () => (reached++, Response.json({ success: true, data: { success: true, message: SIGNIN_SENT_MESSAGE } }, { headers: { "Cache-Control": "private, no-store" } }));
	for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal((await coywolfPack()(middlewareContext(sendRequest({ email: ADMIN })), emdash)).status, 200);
	assert.equal(reached, EMAIL_LIMIT.max, "under the limit, EmDash answers");
	const held = await coywolfPack()(middlewareContext(sendRequest({ email: ADMIN })), emdash);
	assert.equal(reached, EMAIL_LIMIT.max, "over it, EmDash's route isn't called");
	assert.deepEqual(await held.json(), { success: true, data: { success: true, message: SIGNIN_SENT_MESSAGE } });
	// Another route with the same body, and a page: on to the site as before.
	let other = 0;
	await coywolfPack()(middlewareContext(sendRequest({ email: ADMIN }, { path: "/_emdash/api/auth/magic-link/verify" })), async () => (other++, new Response("ok")));
	await coywolfPack()(middlewareContext(new Request("https://example.com/about/")), async () => (other++, new Response("<p>page</p>", { headers: { "content-type": "text/html" } })));
	assert.equal(other, 2);
	await Promise.allSettled(globalThis.__waitUntil);
});

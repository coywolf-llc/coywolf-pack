// Run: node --test test/signin-delegation.test.mjs
// Sign-in email limit, end to end: the pack middleware (src/middleware.ts) on Astro's own middleware runtime
// (astro/container runs the chain through Astro's sequence, callMiddleware and endpoint dispatch), in front of
// EmDash's real magic-link route (emdash/dist/astro/routes/api/auth/magic-link/send.mjs) on a database built by
// EmDash's migrations. A request over its address's limit must reach EmDash's route once, as a request for
// `<16 hex>@held.invalid`, so everything the sender can see is what EmDash does for an address without an
// account: the status (503 when the site has no email provider), the headers, the body, the count against
// EmDash's IP limit, and EmDash's own pause (none once the IP is over that limit).
//
// These fail if Astro stops handing the route the context's request, or EmDash's route changes what it
// reads: see docs/internals.md ("Sign-in email limits").
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CompiledQuery, Kysely, sql } from "kysely";

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
		if (specifier === "virtual:emdash/config") return { url: "data:text/javascript,export default {};", shortCircuit: true };
		return next(specifier, context);
	},
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const emdashDir = join(root, "node_modules/emdash");
const SEND = "/_emdash/api/auth/magic-link/send";
const HELD_EMAIL = /^[0-9a-f]{16}@held\.invalid$/;

const { experimental_AstroContainer } = await import("astro/container");
const { sequence } = await import("astro/middleware");
const { coywolfPack } = await import("../src/middleware.ts");
const limit = await import("../src/core/signin-limit.ts");
const { EMAIL_LIMIT, emailKey } = limit;
/** EmDash's own route handler. */
const { POST } = await import(pathToFileURL(join(emdashDir, "dist/astro/routes/api/auth/magic-link/send.mjs")).href);

let db;
let createUser;

/** A D1Database over the Kysely connection: the pack's SQL on the database EmDash's route uses. */
function d1Over(kysely) {
	const run = (query, params) => kysely.executeQuery(CompiledQuery.raw(query, params));
	const statement = (query, params = []) => ({
		bind: (...values) => statement(query, values),
		all: async () => ({ results: (await run(query, params)).rows, success: true, meta: {} }),
		first: async () => (await run(query, params)).rows[0] ?? null,
		run: async () => ({ success: true, results: (await run(query, params)).rows, meta: {} }),
	});
	return { prepare: (query) => statement(query), batch: async (statements) => Promise.all(statements.map((s) => s.all())) };
}

// One window for the pack's count and EmDash's, whenever the tests run (both read Date.now).
const realNow = Date.now;
const NOW = Date.UTC(2026, 0, 5, 9, 1, 0);

before(async () => {
	const { createDialect } = await import("emdash/db/sqlite");
	const { runMigrations } = await import("emdash/db");
	db = new Kysely({ dialect: createDialect({ url: ":memory:" }) });
	await runMigrations(db);
	// EmDash's own auth adapter, resolved the way EmDash's route resolves it.
	const { createKyselyAdapter } = await import(pathToFileURL(createRequire(join(emdashDir, "package.json")).resolve("@emdash-cms/auth/adapters/kysely")).href);
	const adapter = createKyselyAdapter(db);
	createUser = (email) => adapter.createUser({ email, name: email });
	globalThis.__testEnv = { DB: d1Over(db) };
	globalThis.__waitUntil = [];
	Date.now = () => NOW;
});

after(async () => {
	Date.now = realNow;
	await Promise.allSettled(globalThis.__waitUntil ?? []);
	await db?.destroy();
});

let lastIp = 0;

/**
 * A site: Astro's middleware runtime with `chain` as its middleware, EmDash's route at the end. `email` is
 * EmDash's email pipeline (locals.emdash.email). Records what the route was handed and how often each part ran.
 */
async function site(chain, { available = true } = {}) {
	const log = { pre: 0, post: 0, route: [], sent: [], timers: [] };
	const emdash = {
		db,
		config: {},
		email: {
			isAvailable: () => available,
			send: async (message) => void log.sent.push(message.to),
		},
	};
	const pre = async (_context, next) => (log.pre++, next());
	const post = async (_context, next) => (log.post++, next());
	const container = await experimental_AstroContainer.create({ manifest: { middleware: async () => ({ onRequest: chain({ pre, post, pack: coywolfPack() }) }) } });
	const endpoint = {
		POST: async (context) => {
			log.route.push(await context.request.clone().json());
			return POST(context);
		},
	};
	return {
		log,
		/** A sign-in request from `from` (an IP address no test has used unless given: EmDash limits each to 3), as Cloudflare hands it to the Worker. */
		async send(email, from = `198.51.100.${++lastIp}`) {
			const text = JSON.stringify({ email });
			const request = new Request(`https://example.com${SEND}`, {
				method: "POST",
				body: text,
				headers: { "content-type": "application/json", "content-length": String(text.length), "cf-connecting-ip": from, origin: "https://example.com" },
			});
			Object.defineProperty(request, "cf", { value: { colo: "TEST" } });
			// The pauses anyone takes while the request is answered (EmDash's is 100 to 250 ms for an unknown address).
			const realSetTimeout = globalThis.setTimeout;
			const timers = [];
			globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 50 && timers.push(Math.round(ms)), realSetTimeout(fn, ms, ...rest));
			try {
				const response = await container.renderToResponse(endpoint, { routeType: "endpoint", request, locals: { emdash } });
				return { status: response.status, headers: [...response.headers], body: await response.json(), timers };
			} finally {
				globalThis.setTimeout = realSetTimeout;
			}
		},
	};
}

const ipCount = async (ip) => Number((await sql`SELECT count FROM _emdash_rate_limits WHERE key = ${`${ip}:magic-link/send`}`.execute(db)).rows[0]?.count ?? 0);
const addressCount = async (email) => Number((await sql`SELECT count FROM _emdash_rate_limits WHERE key = ${await emailKey(email)}`.execute(db)).rows[0]?.count ?? 0);
const SENT = { success: true, data: { success: true, message: "If an account exists for this email, a magic link has been sent." } };

// Where the pack can be in a site's chain. EmDash's own middleware is all order "pre" (before the site's), so
// with `sequence(coywolfPack())` the pack is the last middleware before the route.
const CHAINS = {
	"the pack alone": ({ pack }) => pack,
	"the pack last, after EmDash's middleware": ({ pre, pack }) => sequence(pre, sequence(pack)),
	"the pack first in the site's sequence, a middleware after it": ({ pre, pack, post }) => sequence(pre, sequence(pack, post)),
};

for (const [name, chain] of Object.entries(CHAINS)) {
	test(`on Astro's middleware runtime (${name}): a held request reaches EmDash's route once, as an address nobody has, and nothing runs twice`, async () => {
		const user = `chain-${Object.keys(CHAINS).indexOf(name)}@example.com`;
		await createUser(user);
		const { log, send } = await site(chain);
		for (let i = 0; i < EMAIL_LIMIT.max; i++) assert.equal((await send(user)).status, 200, `request ${i + 1}`);
		assert.deepEqual(log.route, Array(EMAIL_LIMIT.max).fill({ email: user }), "under the limit, the route gets the request as sent");
		assert.deepEqual(log.sent, Array(EMAIL_LIMIT.max).fill(user), "and EmDash emails the link");

		const held = await send(user);
		assert.equal(log.route.length, EMAIL_LIMIT.max + 1, "the route ran once for the held request (no loop, no second run)");
		assert.match(log.route.at(-1).email, HELD_EMAIL, "with the address nobody has");
		assert.equal(log.sent.length, EMAIL_LIMIT.max, "no email");
		const expected = name === "the pack alone" ? 0 : EMAIL_LIMIT.max + 1;
		assert.equal(log.pre, expected, "the middleware before the pack ran once per request");
		if (name.includes("after it")) assert.equal(log.post, EMAIL_LIMIT.max + 1, "and the one after it");
		assert.deepEqual({ status: held.status, body: held.body }, { status: 200, body: SENT });
	});
}

test("a user's held request and a request for an address without an account get the same from EmDash: status, headers, body, its IP count and its pause", async () => {
	const user = "held-same@example.com";
	await createUser(user);
	const { log, send } = await site(CHAINS["the pack last, after EmDash's middleware"]);
	for (let i = 0; i < EMAIL_LIMIT.max; i++) await send(user);
	assert.equal(log.sent.length, EMAIL_LIMIT.max);

	// From an IP address EmDash hasn't limited: EmDash counts the request and pauses, for both.
	const held = await send(user, "203.0.113.1");
	const stranger = await send("nobody@example.com", "203.0.113.2");
	assert.match(log.route.at(-2).email, HELD_EMAIL);
	assert.deepEqual(log.route.at(-1), { email: "nobody@example.com" });
	assert.deepEqual({ status: held.status, headers: held.headers, body: held.body }, { status: stranger.status, headers: stranger.headers, body: stranger.body });
	assert.deepEqual(held.body, SENT);
	assert.equal(await ipCount("203.0.113.1"), 1, "EmDash counted the held request against its IP limit");
	assert.equal(await ipCount("203.0.113.2"), 1);
	for (const [who, answer] of [["held", held], ["stranger", stranger]]) {
		assert.equal(answer.timers.length, 1, `${who}: one pause, EmDash's own`);
		assert.ok(answer.timers[0] >= 100 && answer.timers[0] <= 250, `${who}: ${answer.timers[0]} ms`);
	}

	// From an IP address over EmDash's limit (3 per 5 minutes): EmDash answers at once, and so does a held request.
	for (let i = 0; i < 3; i++) await send(`nobody${i}@example.com`, "203.0.113.3");
	const heldOver = await send(user, "203.0.113.3");
	const strangerOver = await send("nobody@example.com", "203.0.113.3");
	assert.match(log.route.at(-2).email, HELD_EMAIL);
	assert.deepEqual({ status: heldOver.status, headers: heldOver.headers, body: heldOver.body }, { status: strangerOver.status, headers: strangerOver.headers, body: strangerOver.body });
	assert.deepEqual(heldOver.body, SENT);
	assert.deepEqual(heldOver.timers, [], "no pause for the held request: the pack adds none");
	assert.deepEqual(strangerOver.timers, []);
	assert.equal(await ipCount("203.0.113.3"), 5, "both counted by EmDash");
	assert.equal(log.sent.length, EMAIL_LIMIT.max, "still no more email");
	// Only the user's address has a row of the pack's.
	assert.equal(await addressCount(user), EMAIL_LIMIT.max + 2);
	assert.equal(await addressCount("nobody@example.com"), 0);
});

test("with no email provider, EmDash answers 503 to everyone, a user's held request included; the requests still count", async () => {
	const user = "no-provider@example.com";
	await createUser(user);
	const { log, send } = await site(CHAINS["the pack last, after EmDash's middleware"], { available: false });
	const answers = [];
	for (let i = 0; i < EMAIL_LIMIT.max + 1; i++) answers.push(await send(user));
	const stranger = await send("nobody@example.com");
	assert.match(log.route.at(-2).email, HELD_EMAIL, "the 4th was held");
	for (const [i, answer] of answers.entries()) {
		assert.equal(answer.status, 503, `request ${i + 1}`);
		assert.equal(answer.body.error.code, "EMAIL_NOT_CONFIGURED");
		assert.deepEqual({ headers: answer.headers, body: answer.body, timers: answer.timers }, { headers: stranger.headers, body: stranger.body, timers: stranger.timers }, `request ${i + 1} is what someone without an account gets`);
	}
	assert.equal(stranger.status, 503);
	assert.deepEqual(log.sent, []);
	// Requests are counted, not emails: none was sent, and the address is held for the rest of its window.
	assert.equal(await addressCount(user), EMAIL_LIMIT.max + 1);
});

test("EmDash's schema accepts the held address, and its route still reads what the pack relies on", async () => {
	const { magicLinkSendBody } = await import("emdash/api/schemas");
	for (let i = 0; i < 20; i++) {
		const email = limit.heldEmail();
		assert.match(email, HELD_EMAIL);
		assert.equal(magicLinkSendBody.safeParse({ email }).success, true, email);
	}
	// The route takes the request from its context and the address from the body, counts by IP before it looks at email, and pauses only for an unknown address.
	const route = readFileSync(join(emdashDir, "src/astro/routes/api/auth/magic-link/send.ts"), "utf8");
	assert.match(route, /POST: APIRoute = async \(\{ request, locals \}\)/);
	assert.ok(route.indexOf("checkRateLimit(") < route.indexOf("email?.isAvailable()"), "EmDash's IP limit comes before its email check");
	assert.ok(route.indexOf("email?.isAvailable()") < route.indexOf("sendMagicLink("));
});

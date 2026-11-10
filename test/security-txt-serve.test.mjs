// Run: node --test test/security-txt-serve.test.mjs
//
// The security.txt middleware with the Discovery settings in D1 (read with the feature switches,
// as on a site): the file at /.well-known/security.txt, kept at the edge for a day with its tag,
// the legacy /security.txt redirect, and HEAD.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: "data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = () => {};",
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

/** A D1 stand-in for the switches' one query: SELECT name, value FROM options WHERE name IN (…). */
function db(rows) {
	return {
		prepare: () => ({ bind: (...names) => ({ all: async () => ({ results: Object.entries(rows).filter(([name]) => names.includes(name)).map(([name, value]) => ({ name, value: JSON.stringify(value) })) }) }) }),
	};
}

globalThis.__testEnv = {
	DB: db({
		"plugin:coywolf-pack:settings:features": { discovery: true, "discovery.securityTxt": true },
		// EmDash's Site URL: Canonical uses it, not the address the file was asked for.
		"site:url": "https://coywolf.com/",
		"plugin:coywolf-pack:settings:discoverySettings": { securityTxt: { contacts: ["security@coywolf.com"], policy: "https://coywolf.com/disclosure/", languages: "en", encryption: "", acknowledgments: "", hiring: "" } },
	}),
};

const { securityTxtMiddleware, siteUrlOrigin } = await import("../src/discovery/middleware.ts");
const { SECURITY_TXT_MAX_AGE, SECURITY_TXT_TAG } = await import("../src/discovery/security-txt.ts");

function context(path, method = "GET") {
	const sets = [];
	return { sets, url: new URL(`https://coywolf-preview.example${path}`), request: new Request(`https://coywolf-preview.example${path}`, { method }), cache: { enabled: true, set: (o) => sets.push(o) } };
}

test("Canonical: EmDash's Site URL when it's set, else the request's origin", () => {
	assert.equal(siteUrlOrigin(JSON.stringify("https://coywolf.com/blog/")), "https://coywolf.com");
	for (const raw of [null, undefined, "", "not json", JSON.stringify(""), JSON.stringify("coywolf.com"), JSON.stringify(42)]) assert.equal(siteUrlOrigin(raw), null, String(raw));
});

test("serves the file, kept at the edge for a day with its tag", async () => {
	const c = context("/.well-known/security.txt");
	const res = await securityTxtMiddleware.handle(c, globalThis.__testEnv, () => undefined);
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type"), /^text\/plain; charset=utf-8/);
	assert.equal(res.headers.get("cache-control"), `public, max-age=${SECURITY_TXT_MAX_AGE}`);
	const body = await res.text();
	assert.match(body, /^Contact: mailto:security@coywolf\.com$/m);
	assert.match(body, /^Expires: \d{4}-\d\d-\d\dT00:00:00Z$/m);
	assert.match(body, /^Canonical: https:\/\/coywolf\.com\/\.well-known\/security\.txt$/m);
	assert.match(body, /^Policy: https:\/\/coywolf\.com\/disclosure\/$/m);
	assert.deepEqual(c.sets, [false, { maxAge: SECURITY_TXT_MAX_AGE, swr: 0, tags: [SECURITY_TXT_TAG] }]);
	const expires = Date.parse(body.match(/^Expires: (.+)$/m)[1]);
	assert.ok(expires - Date.now() > 360 * 86_400_000 && expires - Date.now() < 365 * 86_400_000);
});

test("HEAD answers without a body; /security.txt redirects to the well-known path", async () => {
	const head = await securityTxtMiddleware.handle(context("/.well-known/security.txt", "HEAD"), globalThis.__testEnv, () => undefined);
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	const legacy = context("/security.txt");
	const redirect = await securityTxtMiddleware.handle(legacy, globalThis.__testEnv, () => undefined);
	assert.equal(redirect.status, 301);
	assert.equal(redirect.headers.get("location"), "/.well-known/security.txt");
	assert.deepEqual(legacy.sets.at(-1).tags, [SECURITY_TXT_TAG]);
});

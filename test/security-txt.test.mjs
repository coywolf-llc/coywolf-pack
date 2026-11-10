// Run: node --test test/security-txt.test.mjs
//
// security.txt (RFC 9116) in Discovery: the file built from the settings, an Expires date that's
// always about a year ahead, what can't be saved, and the middleware that serves it at the edge.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { EXPIRES_DAYS, SECURITY_TXT_DEFAULTS, SECURITY_TXT_TAG, buildSecurityTxt, contactUri, languageList, securityTxtExpires, securityTxtProblems } = await import("../src/discovery/security-txt.ts");
const { settingsSchema } = await import("../src/discovery/settings.ts");

const settings = (patch = {}) => ({ ...SECURITY_TXT_DEFAULTS, contacts: ["security@coywolf.com"], ...patch });

test("contacts become RFC 9116 URIs; anything else is refused", () => {
	assert.equal(contactUri("security@coywolf.com"), "mailto:security@coywolf.com");
	assert.equal(contactUri("mailto:security@coywolf.com"), "mailto:security@coywolf.com");
	assert.equal(contactUri("https://coywolf.com/security/"), "https://coywolf.com/security/");
	assert.equal(contactUri("tel:+1 (555) 010-0000"), "tel:+1555010-0000");
	for (const bad of ["http://coywolf.com/security", "security", "mailto:nope", "javascript:alert(1)", ""]) assert.equal(contactUri(bad), null, bad);
	assert.deepEqual(securityTxtProblems(settings({ contacts: ["security@coywolf.com", "http://x.test"] })).length, 1);
	assert.deepEqual(securityTxtProblems(settings({ policy: "http://coywolf.com/policy" })), ["The policy must be an https:// URL."]);
	assert.deepEqual(securityTxtProblems(settings({ languages: "en, fr-CA, english!" })).length, 1);
	assert.deepEqual(securityTxtProblems(settings()), []);
	assert.deepEqual(languageList("en, fr-CA  de"), ["en", "fr-CA", "de"]);
});

test("Expires is always less than a year ahead and more than 363 days", () => {
	for (const at of [Date.UTC(2026, 10, 10, 0, 0, 0), Date.UTC(2026, 10, 10, 23, 59, 59), Date.UTC(2027, 1, 28, 12), Date.UTC(2028, 1, 29, 6)]) {
		const expires = Date.parse(securityTxtExpires(at));
		const days = (expires - at) / 86_400_000;
		assert.ok(days < 365 && days > EXPIRES_DAYS - 1, `${new Date(at).toISOString()}: ${days} days`);
	}
	assert.equal(securityTxtExpires(Date.UTC(2026, 10, 10, 15)), "2027-11-09T00:00:00Z");
});

test("the file: required fields first, optional ones only when set, Canonical at the site", () => {
	const now = Date.UTC(2026, 10, 10, 9);
	assert.equal(
		buildSecurityTxt(settings({ contacts: ["security@coywolf.com", "https://coywolf.com/security/"], policy: "https://coywolf.com/disclosure/", languages: "en, fr" }), "https://coywolf.com", now),
		[
			"# coywolf.com: how to report a security problem (RFC 9116).",
			"Contact: mailto:security@coywolf.com",
			"Contact: https://coywolf.com/security/",
			"Expires: 2027-11-09T00:00:00Z",
			"Preferred-Languages: en, fr",
			"Canonical: https://coywolf.com/.well-known/security.txt",
			"Policy: https://coywolf.com/disclosure/",
			"",
		].join("\n"),
	);
	const full = buildSecurityTxt(settings({ encryption: "https://coywolf.com/pgp.txt", acknowledgments: "https://coywolf.com/thanks/", hiring: "https://coywolf.com/jobs/", languages: "" }), "https://coywolf.com/", now);
	assert.match(full, /^Encryption: https:\/\/coywolf\.com\/pgp\.txt$/m);
	assert.match(full, /^Acknowledgments: https:\/\/coywolf\.com\/thanks\/$/m);
	assert.match(full, /^Hiring: https:\/\/coywolf\.com\/jobs\/$/m);
	assert.doesNotMatch(full, /Preferred-Languages/);
	assert.match(full, /^Canonical: https:\/\/coywolf\.com\/\.well-known\/security\.txt$/m);
	// No valid contact: no file.
	assert.equal(buildSecurityTxt(settings({ contacts: ["", "nope"] }), "https://coywolf.com", now), null);
	assert.equal(buildSecurityTxt(SECURITY_TXT_DEFAULTS, "https://coywolf.com", now), null);
});

test("a site without security.txt settings parses to the defaults, and the other Discovery settings are kept", () => {
	const parsed = settingsSchema.parse({ feed: { items: 5 } });
	assert.deepEqual(parsed.securityTxt, SECURITY_TXT_DEFAULTS);
	assert.equal(parsed.feed.items, 5);
	// The defaults aren't shared between parses.
	parsed.securityTxt.contacts.push("x");
	assert.deepEqual(settingsSchema.parse({}).securityTxt.contacts, []);
});

test("the Discovery part is off by default and the save route refuses invalid entries", async () => {
	const { discoveryPack } = await import("../src/discovery/pack.ts");
	const pack = discoveryPack({});
	assert.equal(pack.features.find((f) => f.id === "discovery.securityTxt")?.default, false);
	const save = pack.routes["discovery/save"];
	const stored = new Map();
	const ctx = {
		input: { securityTxt: { ...SECURITY_TXT_DEFAULTS, contacts: ["http://coywolf.com/x"] } },
		settings: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => stored.set(k, v) },
		log: { warn() {} },
	};
	await assert.rejects(save.handler(ctx), /security\.txt: .*https:\/\//);
	assert.equal(stored.size, 0);
	await save.handler({ ...ctx, input: { securityTxt: { ...SECURITY_TXT_DEFAULTS, contacts: [" security@coywolf.com ", "", "  "] } }, kv: { get: async () => null } }).catch(() => undefined);
	assert.deepEqual(stored.get("discoverySettings")?.securityTxt.contacts, ["security@coywolf.com"], "blank lines and spaces aren't kept");
});

test("the middleware serves it at /.well-known/security.txt, kept at the edge with its tag; /security.txt redirects", async () => {
	const { securityTxtMiddleware } = await import("../src/discovery/middleware.ts");
	const features = await import("../src/core/features.ts");
	assert.equal(securityTxtMiddleware.feature, "discovery.securityTxt");
	assert.equal(securityTxtMiddleware.ownsCache, true);
	// Outside a Worker the settings can't be read: the request goes on to the site.
	const context = (path, method = "GET") => {
		const sets = [];
		return { sets, url: new URL(`https://coywolf.com${path}`), request: new Request(`https://coywolf.com${path}`, { method }), cache: { enabled: true, set: (o) => sets.push(o) } };
	};
	assert.equal(await securityTxtMiddleware.handle(context("/.well-known/security.txt"), {}, () => undefined), undefined);
	assert.equal(await securityTxtMiddleware.handle(context("/other.txt"), {}, () => undefined), undefined);
	assert.equal(await securityTxtMiddleware.handle(context("/.well-known/security.txt", "POST"), {}, () => undefined), undefined);
	assert.equal(typeof features.readSiteSetting, "function");
	assert.equal(SECURITY_TXT_TAG, "coywolf:security-txt");
});

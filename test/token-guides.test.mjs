// Run: node --test test/token-guides.test.mjs
//
// The Cloudflare token guides (src/core/guide-content.ts): one pre-filled form for the one Cloudflare API token,
// written for Cloudflare's token editor (permission policies with a scope), using only keys from Cloudflare's
// permission reference and saying exactly what the form should show; module guides say what the token needs there.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { GUIDES, CLOUDFLARE_PERMISSIONS, CLOUDFLARE_TOKEN_FORM, tokenFormUrl } = await import("../src/core/guide-content.ts");

// developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/ (permission reference).
const DOCUMENTED = new Set(["account_analytics", "account_api_tokens", "account_settings", "billing", "workers_scripts", "workers_kv_storage", "workers_routes", "workers_r2", "d1", "queues", "page", "stream", "images", "account_logs", "dns", "zone", "zone_settings", "analytics", "firewall_services", "page_rules", "cache", "ssl_and_certificates", "logs"]);
const ZONE_KEYS = new Set(["dns", "zone", "zone_settings", "analytics", "firewall_services", "page_rules", "cache", "ssl_and_certificates", "logs"]);
const FEATURE_GUIDES = ["stream", "radar", "images-token", "crawler-hints-token", "checkup-read-token", "checkup-setup-token", "insights-token", "backups-token", "browser-run-token", "files-token", "usage-token"];

const formLinks = (html) => [...html.matchAll(/href="(https:\/\/dash\.cloudflare\.com\/\?to=\/:account\/api-tokens(?:&amp;|&)permissionGroupKeys=[^"]+)"/g)].map((m) => new URL(m[1].replaceAll("&amp;", "&")));
const text = (html) => html.replace(/<[^>]+>/g, "");

test("the pre-filled form URL is Cloudflare's account token template", () => {
	const url = new URL(tokenFormUrl("Coywolf Pack read-only", [{ key: "zone", type: "read" }]));
	assert.equal(url.origin + url.pathname, "https://dash.cloudflare.com/");
	assert.equal(url.searchParams.get("to"), "/:account/api-tokens");
	assert.deepEqual(JSON.parse(url.searchParams.get("permissionGroupKeys")), [{ key: "zone", type: "read" }]);
	assert.equal(url.searchParams.get("name"), "Coywolf Pack read-only");
	// The link Crawler Hints shipped with in 0.35.18, unchanged.
	assert.equal(url.href.replace("https://dash.cloudflare.com/?", ""), "to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D&name=Coywolf%20Pack%20read-only");
});

test("one pre-filled form in all the guides: documented keys only, never D1, each key in the policy its scope belongs to", () => {
	const forms = Object.entries(GUIDES).flatMap(([id, g]) => formLinks(g.steps.join(" ")).map((url) => ({ id, url })));
	assert.deepEqual(forms.map((f) => f.id), ["cloudflare-token"], "only the Cloudflare API token guide has a form; the module guides point to it");
	const keys = JSON.parse(forms[0].url.searchParams.get("permissionGroupKeys"));
	assert.equal(forms[0].url.searchParams.get("name"), CLOUDFLARE_TOKEN_FORM.name);
	assert.ok(keys.length > 0);
	for (const { key, type } of keys) {
		assert.ok(DOCUMENTED.has(key), `${key} isn't in Cloudflare's permission reference`);
		assert.ok(["read", "edit"].includes(type), `${key}: ${type}`);
	}
	// Restores keep their own D1 Edit token: the token saved in the database must not be able to rewrite it.
	assert.ok(!keys.some((k) => k.key === "d1"));
	assert.ok(!Object.values(CLOUDFLARE_PERMISSIONS).some((p) => /\bD1\b/.test(p.name)));
	for (const p of Object.values(CLOUDFLARE_PERMISSIONS)) if (p.form) assert.equal(ZONE_KEYS.has(p.form.key), p.scope === "zone", `${p.name} is listed in the ${p.scope} policy`);
});

test("the guide says exactly what the form shows, and lists everything else to add by hand", () => {
	const guide = GUIDES["cloudflare-token"].steps.join(" ");
	const plain = text(guide);
	const shows = guide.slice(guide.indexOf("The form should show"), guide.indexOf(". Add the rest by hand"));
	const byHand = guide.slice(guide.indexOf("Add the rest by hand"), guide.indexOf("You can skip"));
	assert.match(text(shows), new RegExp(`the name ${CLOUDFLARE_TOKEN_FORM.name} and two policies`));
	const named = (html, name) => html.includes(`>${name}</strong>`);
	for (const p of Object.values(CLOUDFLARE_PERMISSIONS)) {
		// A pre-filled permission is named among what the form shows, and nowhere in the by-hand list; the others the reverse.
		assert.equal(named(shows, p.name), Boolean(p.form), `${p.name}: shows`);
		assert.equal(named(byHand, p.name), !p.form, `${p.name}: added by hand`);
	}
	assert.match(guide, /Permission policies/);
	assert.match(plain, /Specified Domains and pick this site's domain \(recommended/);
	assert.match(plain, /choose All Domains instead/);
	assert.match(plain, /CLOUDFLARE_API_TOKEN/);
});

test("module guides say what the Cloudflare API token needs there, using only permissions the token's guide covers", () => {
	const names = Object.values(CLOUDFLARE_PERMISSIONS).map((p) => p.name);
	for (const id of FEATURE_GUIDES) {
		const plain = text(GUIDES[id].steps.join(" "));
		const needs = plain.match(/Here it needs (.+?)\./)?.[1];
		assert.ok(needs, `${id} says what it needs`);
		for (const permission of needs.split(/, | and /)) assert.ok(names.includes(permission), `${id} needs "${permission}", which the Cloudflare API token's guide doesn't cover`);
		assert.match(plain, /Cloudflare API token from the plugin's Settings page/, id);
		assert.match(plain, /Permission policies/, id);
		assert.doesNotMatch(plain, /Under Account Resources|Under Zone Resources/, id);
	}
});

test("admin pages use the one form: no page builds a token form of its own", () => {
	const src = new URL("../src/", import.meta.url).pathname;
	const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : /\.tsx?$/.test(name) ? [join(dir, name)] : []));
	for (const file of files(src)) {
		if (file.endsWith("core/guide-content.ts")) continue;
		assert.doesNotMatch(readFileSync(file, "utf8"), /tokenFormUrl\(/, `${file} builds its own pre-filled token form`);
	}
});

test("the docs' permission table is the token's: same permissions, policies and what's pre-filled", () => {
	const doc = readFileSync(new URL("../docs/README.md", import.meta.url), "utf8");
	const section = doc.slice(doc.indexOf("## The Cloudflare API token"), doc.indexOf("## Moving to EmDash"));
	const rows = [...section.matchAll(/^\| ([^|]+→[^|]+) \| (Entire Account|This site's domain) \| (Yes|By hand) \|/gm)].map((m) => [m[1].trim(), m[2] === "Entire Account" ? "account" : "zone", m[3] === "Yes"]);
	assert.deepEqual(rows, Object.values(CLOUDFLARE_PERMISSIONS).map((p) => [p.name, p.scope, Boolean(p.form)]));
});

// Run: node --test test/token-guides.test.mjs
//
// The Cloudflare token guides (src/core/guide-content.ts) are written for Cloudflare's token
// editor (permission policies with a scope), and their pre-filled forms use only keys from
// Cloudflare's permission reference, with each guide saying what the form should show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { GUIDES, tokenFormUrl } = await import("../src/core/guide-content.ts");

// developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/ (permission reference).
const DOCUMENTED = new Set(["account_analytics", "account_api_tokens", "account_settings", "billing", "workers_scripts", "workers_kv_storage", "workers_routes", "workers_r2", "d1", "queues", "page", "stream", "images", "account_logs", "dns", "zone", "zone_settings", "analytics", "firewall_services", "page_rules", "cache", "ssl_and_certificates", "logs"]);
const TOKEN_GUIDES = ["stream", "radar", "images-token", "crawler-hints-token", "checkup-read-token", "checkup-setup-token", "insights-token", "backups-token"];

const formLinks = (html) => [...html.matchAll(/href="(https:\/\/dash\.cloudflare\.com\/\?to=\/:account\/api-tokens&amp;permissionGroupKeys=[^"]+|https:\/\/dash\.cloudflare\.com\/\?to=\/:account\/api-tokens&permissionGroupKeys=[^"]+)"/g)].map((m) => new URL(m[1].replaceAll("&amp;", "&")));

test("the pre-filled form URL is Cloudflare's account token template", () => {
	const url = new URL(tokenFormUrl("Coywolf Pack read-only", [{ key: "zone", type: "read" }]));
	assert.equal(url.origin + url.pathname, "https://dash.cloudflare.com/");
	assert.equal(url.searchParams.get("to"), "/:account/api-tokens");
	assert.deepEqual(JSON.parse(url.searchParams.get("permissionGroupKeys")), [{ key: "zone", type: "read" }]);
	assert.equal(url.searchParams.get("name"), "Coywolf Pack read-only");
	// The link Crawler Hints shipped with in 0.35.18, unchanged.
	assert.equal(url.href.replace("https://dash.cloudflare.com/?", ""), "to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D&name=Coywolf%20Pack%20read-only");
});

test("each token guide uses the token editor's policies and scopes, not the old Resources steps", () => {
	for (const id of TOKEN_GUIDES) {
		const text = GUIDES[id].steps.join(" ");
		assert.match(text, /Permission policies/, id);
		assert.match(text, /All Domains|Entire Account/, id);
		assert.doesNotMatch(text, /Under Account Resources|Under Zone Resources|Get started<\/strong>\.<\/li>/, id);
	}
});

test("pre-filled forms: documented keys only, and the guide says what the form should show", () => {
	let forms = 0;
	for (const id of TOKEN_GUIDES) {
		const html = GUIDES[id].steps.join(" ");
		for (const url of formLinks(html)) {
			forms++;
			const keys = JSON.parse(url.searchParams.get("permissionGroupKeys"));
			for (const { key, type } of keys) {
				assert.ok(DOCUMENTED.has(key), `${id}: ${key} isn't in Cloudflare's permission reference`);
				assert.ok(["read", "edit"].includes(type), `${id}: ${type}`);
			}
			assert.ok(url.searchParams.get("name")?.startsWith("Coywolf Pack"), id);
			assert.match(html, /should show the name/, `${id} says what the form shows`);
		}
	}
	assert.ok(forms >= 3, `found ${forms} pre-filled forms`);
	// The Performance page's read-only token form too.
	const usage = readFileSync(new URL("../src/admin/usage.tsx", import.meta.url), "utf8");
	assert.match(usage, /tokenFormUrl\("Coywolf Pack read-only", \[\s*\{ key: "account_analytics", type: "read" \},\s*\{ key: "account_settings", type: "read" \},\s*\]\)/);
	assert.match(usage, /It should show the name/);
});

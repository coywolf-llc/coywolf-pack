// Run: node --test test/settings-enhance.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import "./ts-resolve.mjs";

const { settingsEnhanceScript, settingsGuideHtml, settingsPageData, injectAdminEnhancements } = await import("../src/core/settings-enhance.ts");
const { SECRET_SETTINGS, OLDER_SECRET_KEYS } = await import("../src/core/secrets.ts");
const { tokenFormUrl, CLOUDFLARE_TOKEN_FORM } = await import("../src/core/guide-content.ts");

test("four fields get guides: the Cloudflare API token, the AI key, Fathom and Google", () => {
	const html = settingsGuideHtml();
	const { cloudflareApiToken, aiApiKey, insightsFathomApiKey, insightsGoogleServiceAccount } = SECRET_SETTINGS;
	assert.deepEqual(Object.keys(html).sort(), [cloudflareApiToken.label, aiApiKey.label, insightsFathomApiKey.label, insightsGoogleServiceAccount.label].sort());
	assert.equal((html[aiApiKey.label].match(/<details/g) ?? []).length, 3);
	// The token's guide is the one pre-filled form, with the zone policy advice.
	const token = html[cloudflareApiToken.label];
	assert.ok(token.includes(tokenFormUrl(CLOUDFLARE_TOKEN_FORM.name, CLOUDFLARE_TOKEN_FORM.keys).replaceAll("&", "&amp;")) || token.includes(tokenFormUrl(CLOUDFLARE_TOKEN_FORM.name, CLOUDFLARE_TOKEN_FORM.keys)));
	assert.match(token, /Specified Domains<\/strong> and pick this site's domain \(recommended/);
	assert.match(token, /All Domains<\/strong> instead/);
});

test("the script carries the older and hidden fields by their labels, and the older ones are every saved token it replaces", () => {
	const data = settingsPageData();
	assert.deepEqual(data.older, OLDER_SECRET_KEYS.map((key) => SECRET_SETTINGS[key].label));
	assert.deepEqual(data.hidden, [SECRET_SETTINGS.videosWebhookSecret.label]);
	// None of the four fields people fill in is hidden or tucked away.
	for (const label of Object.keys(data.guides)) assert.ok(!data.older.includes(label) && !data.hidden.includes(label), label);
	const script = settingsEnhanceScript();
	for (const label of [...data.older, ...data.hidden]) assert.ok(script.includes(JSON.stringify(label)), `the script names ${label}`);
});

test("the script parses and can't close its <script> element", () => {
	const script = settingsEnhanceScript();
	assert.doesNotMatch(script, /<\/script/i);
	assert.doesNotThrow(() => new vm.Script(script));
	assert.equal(settingsEnhanceScript(), script, "built once per isolate");
});

test("injects into admin HTML only, keeps status, headers and Astro cookies", async () => {
	const cookies = Symbol.for("astro.cookies");
	const page = new Response("<html><body><div id=app></div></body></html>", { headers: { "content-type": "text/html; charset=utf-8", "content-length": "44", "x-test": "1" } });
	page[cookies] = "jar";
	const out = await injectAdminEnhancements(page);
	const body = await out.text();
	assert.match(body, /<script data-coywolf-pack>.*<\/script><\/body>/s);
	assert.equal(out.headers.get("x-test"), "1");
	assert.equal(out.headers.get("content-length"), null);
	assert.equal(out[cookies], "jar");

	const json = new Response("{}", { headers: { "content-type": "application/json" } });
	assert.equal(await injectAdminEnhancements(json), json);
	const redirect = new Response(null, { status: 302, headers: { location: "/x", "content-type": "text/html" } });
	assert.equal(await injectAdminEnhancements(redirect), redirect);
});

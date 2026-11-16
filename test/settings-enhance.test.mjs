// Run: node --test test/settings-enhance.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import "./ts-resolve.mjs";

const { settingsEnhanceScript, settingsGuideHtml, settingsPageData, injectAdminEnhancements } = await import("../src/core/settings-enhance.ts");
const { SECRET_SETTINGS, OLDER_SECRET_KEYS } = await import("../src/core/secrets.ts");
const { tokenFormUrl, CLOUDFLARE_TOKEN_FORM } = await import("../src/core/guide-content.ts");

test("five fields get guides: the Cloudflare API token, the AI key, Fathom, Google and Buttondown", () => {
	const html = settingsGuideHtml();
	const { cloudflareApiToken, aiApiKey, insightsFathomApiKey, insightsGoogleServiceAccount, buttondownApiKey } = SECRET_SETTINGS;
	assert.deepEqual(Object.keys(html).sort(), [cloudflareApiToken.label, aiApiKey.label, insightsFathomApiKey.label, insightsGoogleServiceAccount.label, buttondownApiKey.label].sort());
	// Buttondown's guide asks for the least-privilege key, in Buttondown's own labels: Emails → Read & write, Sending
	// Disabled, every other area None. There's no "Emails and drafts" area, and no menu path to the keys page.
	const buttondown = html[buttondownApiKey.label];
	assert.match(buttondown, /Emails<\/strong>: Read &amp; write/);
	assert.match(buttondown, /Sending<\/strong>: Disabled/);
	assert.match(buttondown, /Every other area \(Subscribers, Automations, Forms, Surveys, Settings and Styling\): None/);
	assert.match(buttondown, /<a href="https:\/\/buttondown\.com\/keys"[^>]*>Buttondown's API keys page<\/a> \(buttondown\.com\/keys\)/);
	assert.match(buttondown, /A key belongs to the newsletter that was selected when it was made/);
	assert.doesNotMatch(buttondown, /Emails and drafts|Settings → API keys|: Write\b/);
	assert.match(SECRET_SETTINGS.buttondownApiKey.description, /only Emails → Read & write \(Sending Disabled, every other area None\)/);
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
	// None of the five fields people fill in is hidden or tucked away.
	for (const label of Object.keys(data.guides)) assert.ok(!data.older.includes(label) && !data.hidden.includes(label), label);
	const script = settingsEnhanceScript();
	for (const label of [...data.older, ...data.hidden]) assert.ok(script.includes(JSON.stringify(label)), `the script names ${label}`);
});

test("the script parses and can't close its <script> element", () => {
	const script = settingsEnhanceScript();
	assert.doesNotMatch(script, /<\/script/i);
	// The guides' child lists go in escaped, like every other tag, and come back out whole.
	assert.ok(!script.includes("<ul") && script.includes("\\u003cul class="));
	const token = settingsPageData().guides[SECRET_SETTINGS.cloudflareApiToken.label];
	assert.ok(token.includes("<ul"));
	const data = new vm.Script(`(${script.slice(script.indexOf("var D=") + 6, script.indexOf(";var O="))})`).runInNewContext();
	assert.equal(data[SECRET_SETTINGS.cloudflareApiToken.label], token);
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

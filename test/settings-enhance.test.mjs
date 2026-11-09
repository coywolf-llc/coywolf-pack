// Run: node --test test/settings-enhance.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import "./ts-resolve.mjs";

const { settingsEnhanceScript, settingsGuideHtml, injectAdminEnhancements } = await import("../src/core/settings-enhance.ts");
const { SECRET_SETTINGS } = await import("../src/core/secrets.ts");

test("guides for each credential, keyed by the Settings page label", () => {
	const html = settingsGuideHtml();
	assert.deepEqual(Object.keys(html).sort(), [SECRET_SETTINGS.aiApiKey.label, SECRET_SETTINGS.filesR2SecretAccessKey.label, SECRET_SETTINGS.imagesApiToken.label, SECRET_SETTINGS.robotsRadarToken.label, SECRET_SETTINGS.videosApiToken.label].sort());
	assert.equal((html[SECRET_SETTINGS.aiApiKey.label].match(/<details/g) ?? []).length, 3);
	assert.match(html[SECRET_SETTINGS.videosApiToken.label], /<ol[^>]*>.*Account → Stream → Edit/);
	assert.match(html[SECRET_SETTINGS.imagesApiToken.label], /<ol[^>]*>.*Zone → Transform Rules → Edit/);
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

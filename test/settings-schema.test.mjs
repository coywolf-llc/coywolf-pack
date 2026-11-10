// The plugin's EmDash settingsSchema (the generic Settings page) must hold secrets only,
// and every secret the code reads or writes must stay declared there, or EmDash stops
// encrypting it (and reading an encrypted value whose key isn't declared secret throws).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { SECRET_SETTINGS, secretSettingsSchema } = await import("../src/core/secrets.ts");

const SRC = new URL("../src/", import.meta.url).pathname;
const files = (dir) =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
	});
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

test("settingsSchema contains only secret fields", () => {
	const schema = secretSettingsSchema([]);
	assert.ok(Object.keys(schema).length > 0);
	for (const [key, field] of Object.entries(schema)) assert.equal(field.type, "secret", `${key} is not a secret`);
});

test("the known secrets keep their stored keys", () => {
	assert.deepEqual(Object.keys(SECRET_SETTINGS).sort(), ["aiApiKey", "filesR2SecretAccessKey", "imagesApiToken", "robotsRadarToken", "socialImagesApiToken", "usageApiToken", "videosApiToken", "videosWebhookSecret"]);
	assert.match(read("social/render.ts"), /TOKEN_SETTING = "socialImagesApiToken"/);
	assert.match(read("ai/store.ts"), /aiApiKey: \{ type: "secret"/);
	assert.match(read("files/module.ts"), /"filesR2SecretAccessKey"/);
	assert.match(read("videos/store.ts"), /token: "videosApiToken"/);
	assert.match(read("videos/store.ts"), /webhookSecret: "videosWebhookSecret"/);
	assert.match(read("robots/radar.ts"), /RADAR_TOKEN_SETTING = "robotsRadarToken"/);
	assert.match(read("images/settings.ts"), /token: "imagesApiToken"/);
	assert.match(read("pageCache/usage.ts"), /USAGE_TOKEN_SETTING = "usageApiToken"/);
	// Removed with Bing submission (0.35.18): no longer declared, and deleted from storage (retireIndexNow).
	assert.match(read("discovery/settings.ts"), /RETIRED_SETTINGS = \["discoveryIndexnowKey", "discoveryBingApiKey"\]/);
});

test("non-secret module fields are dropped; module secrets are kept", () => {
	const schema = secretSettingsSchema([
		{ demoColor: { type: "string", label: "Color", default: "" }, demoToken: { type: "secret", label: "Token" } },
		undefined,
		{ aiApiKey: { type: "string", label: "would downgrade a secret" } },
	]);
	assert.equal(schema.demoColor, undefined);
	assert.equal(schema.demoToken?.type, "secret");
	assert.equal(schema.aiApiKey.type, "secret");
});

test("modules don't declare non-secret settingsSchema fields", () => {
	for (const path of files(SRC)) {
		if (path.endsWith("core/secrets.ts") || path.endsWith("core/module.ts") || path.endsWith("src/index.ts")) continue;
		assert.doesNotMatch(readFileSync(path, "utf8"), /^\s*settingsSchema\s*:/m, `${path} declares settingsSchema; put secrets in src/core/secrets.ts`);
	}
});

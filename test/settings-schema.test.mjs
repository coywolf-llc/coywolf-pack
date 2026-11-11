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
	// Every key a site may have stored stays declared (EmDash throws reading an encrypted value whose key isn't), the
	// Cloudflare API token first: the object's order is the Settings page's.
	const before036 = ["aiApiKey", "backupsCloudflareToken", "cloudflareSetupToken", "filesR2SecretAccessKey", "imagesApiToken", "insightsFathomApiKey", "insightsGoogleServiceAccount", "robotsRadarToken", "socialImagesApiToken", "usageApiToken", "videosApiToken", "videosWebhookSecret"];
	assert.deepEqual(Object.keys(SECRET_SETTINGS).sort(), [...before036, "cloudflareApiToken"].sort());
	assert.deepEqual(Object.keys(SECRET_SETTINGS).slice(0, 4), ["cloudflareApiToken", "aiApiKey", "insightsFathomApiKey", "insightsGoogleServiceAccount"]);
	// Labels are how the Settings page script finds fields: no two alike.
	const labels = Object.values(SECRET_SETTINGS).map((f) => f.label);
	assert.equal(new Set(labels).size, labels.length);
	assert.match(read("social/render.ts"), /TOKEN_SETTING = "socialImagesApiToken"/);
	assert.match(read("ai/store.ts"), /aiApiKey: \{ type: "secret"/);
	assert.match(read("files/module.ts"), /"filesR2SecretAccessKey"/);
	assert.match(read("videos/store.ts"), /token: "videosApiToken"/);
	assert.match(read("videos/store.ts"), /webhookSecret: "videosWebhookSecret"/);
	assert.match(read("robots/radar.ts"), /RADAR_TOKEN_SETTING = "robotsRadarToken"/);
	assert.match(read("images/settings.ts"), /token: "imagesApiToken"/);
	assert.match(read("pageCache/usage.ts"), /USAGE_TOKEN_SETTING = "usageApiToken"/);
	assert.match(read("backups/module.ts"), /token: "backupsCloudflareToken"/);
	// Removed with Bing submission (0.35.18): no longer declared, and deleted from storage (retireIndexNow).
	assert.match(read("discovery/settings.ts"), /RETIRED_SETTINGS = \["discoveryIndexnowKey", "discoveryBingApiKey"\]/);
});

test("the Settings page's older fields are exactly the tokens the Cloudflare API token replaces, plus the R2 key", async () => {
	const { OLDER_SECRET_KEYS, HIDDEN_SECRET_KEYS } = await import("../src/core/secrets.ts");
	const { OLDER_TOKENS, CLOUDFLARE_TOKEN_SETTING } = await import("../src/core/cloudflare-token.ts");
	const resolverOlder = Object.values(OLDER_TOKENS).flatMap((o) => (o.setting ? [o.setting] : []));
	// A token the resolver treats as older but the page shows up top (or the reverse) would make the page lie about what's in use.
	assert.deepEqual([...OLDER_SECRET_KEYS].sort(), [...resolverOlder, "filesR2SecretAccessKey"].sort());
	for (const key of [...OLDER_SECRET_KEYS, ...HIDDEN_SECRET_KEYS, CLOUDFLARE_TOKEN_SETTING]) assert.ok(key in SECRET_SETTINGS, `${key} is declared`);
	assert.ok(!OLDER_SECRET_KEYS.includes(CLOUDFLARE_TOKEN_SETTING));
	// The resolver's older settings are the ones each module saves its token under.
	assert.equal(OLDER_TOKENS.read.setting, (await import("../src/pageCache/usage.ts")).USAGE_TOKEN_SETTING);
	assert.equal(OLDER_TOKENS.checkupFix.setting, (await import("../src/cloudflare/pack.ts")).SETUP_TOKEN_SETTING);
	assert.equal(OLDER_TOKENS.images.setting, (await import("../src/images/settings.ts")).IMAGES_SETTINGS.token);
	assert.equal(OLDER_TOKENS.stream.setting, (await import("../src/videos/store.ts")).SETTINGS.token);
	assert.equal(OLDER_TOKENS.backupsRetention.setting, (await import("../src/backups/module.ts")).RETENTION_SETTINGS.token);
	assert.equal(OLDER_TOKENS.browserRun.setting, (await import("../src/social/render.ts")).TOKEN_SETTING);
	assert.equal(OLDER_TOKENS.radar.setting, (await import("../src/robots/radar.ts")).RADAR_TOKEN_SETTING);
	// Restores keep their own token: it's never an older token the Cloudflare API token replaces.
	assert.ok(!Object.values(OLDER_TOKENS).some((o) => o.env.includes("BACKUPS_API_TOKEN")));
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

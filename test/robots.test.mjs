// Robots.txt Rules unit tests live next to the module (src/robots/*.test.ts); this pulls them into `node --test test/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

await import("../src/robots/rep.test.ts");
await import("../src/robots/rules.test.ts");

const { radarToken, radarTokenSource, syncRadar } = await import("../src/robots/radar.ts");

test("the Radar token: the Cloudflare API token wins over the older Radar token; the older one and RADAR_API_TOKEN still work alone", async () => {
	const ctx = (settings) => ({ settings: { get: async (k) => settings[k] ?? null } });
	const both = ctx({ cloudflareApiToken: "new-token", robotsRadarToken: "old-token" });
	assert.equal(await radarToken(both, { RADAR_API_TOKEN: "env-token" }), "new-token");
	assert.equal(await radarTokenSource(both, {}), "shared");
	assert.equal(await radarToken(ctx({ robotsRadarToken: "old-token" }), { CLOUDFLARE_API_TOKEN: "shared-env" }), "old-token");
	assert.equal(await radarTokenSource(ctx({ robotsRadarToken: "old-token" }), {}), "settings");
	assert.equal(await radarToken(ctx({}), { RADAR_API_TOKEN: "env-token", CLOUDFLARE_API_TOKEN: "shared-env" }), "env-token");
	assert.equal(await radarTokenSource(ctx({}), { RADAR_API_TOKEN: "env-token" }), "env");
	assert.equal(await radarTokenSource(ctx({}), { CLOUDFLARE_API_TOKEN: "shared-env" }), "shared-env");
	assert.equal(await radarTokenSource(ctx({}), {}), null);
});

test("the weekly sync without any token records what to add, naming the Cloudflare API token and Radar → Read", async () => {
	for (const name of ["CLOUDFLARE_API_TOKEN", "RADAR_API_TOKEN"]) delete process.env[name];
	const kv = new Map();
	const state = await syncRadar({ settings: { get: async () => null }, kv: { set: async (k, v) => void kv.set(k, v) } });
	assert.equal(state.ok, false);
	assert.match(state.error, /Add the Cloudflare API token on the plugin's Settings page.*Radar → Read/);
	assert.deepEqual(kv.get("state:robots.radarSync"), state);
});

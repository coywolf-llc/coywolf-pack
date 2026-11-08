// Update check: version order, the daily npm check and its back-off, and the wiring.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { compareVersions, isNewer, parseVersion, DIST_TAGS_URL, UPDATE_COMMAND } = await import("../src/updates/core.ts");
const { updateStatus } = await import("../src/updates/check.ts");
const { VERSION } = await import("../src/version.ts");

test("compareVersions follows semver order", () => {
	assert.equal(compareVersions("0.35.14", "0.35.13"), 1);
	assert.equal(compareVersions("0.35.13", "0.35.14"), -1);
	assert.equal(compareVersions("0.36.0", "0.35.99"), 1);
	assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
	assert.equal(compareVersions("0.35.10", "0.35.9"), 1, "numeric, not string, order");
	assert.equal(compareVersions("0.35.14", "0.35.14"), 0);
	assert.equal(compareVersions("0.36.0-beta.1", "0.36.0"), -1, "a prerelease comes before its release");
	assert.equal(compareVersions("0.36.0-beta.2", "0.36.0-beta.10"), -1);
	assert.equal(compareVersions("0.36.0-alpha", "0.36.0-beta"), -1);
	assert.equal(compareVersions("0.36.0+build.5", "0.36.0"), 0, "build metadata is ignored");
	assert.equal(compareVersions("latest", "0.35.14"), null);
});

test("isNewer is false for missing, equal, older or malformed versions", () => {
	assert.equal(isNewer("0.35.15", "0.35.14"), true);
	assert.equal(isNewer("0.35.14", "0.35.14"), false);
	assert.equal(isNewer("0.35.13", "0.35.14"), false);
	assert.equal(isNewer(null, "0.35.14"), false);
	assert.equal(isNewer("<script>", "0.35.14"), false);
	assert.equal(parseVersion(" 0.35.14 ")?.core.join("."), "0.35.14");
	assert.equal(parseVersion(35), null);
});

function fakeCtx(answer) {
	const kv = new Map();
	const calls = [];
	return {
		calls,
		kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
		log: { warn() {}, info() {} },
		http: {
			fetch: async (url, init) => {
				calls.push({ url, init });
				const a = typeof answer === "function" ? answer(calls.length) : answer;
				if (a instanceof Error) throw a;
				return new Response(typeof a === "string" ? a : JSON.stringify(a.body), { status: a.status ?? 200 });
			},
		},
	};
}

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-08T12:00:00Z");

test("asks npm's dist-tags and reports a newer version", async () => {
	const ctx = fakeCtx({ body: { latest: "99.0.0" } });
	const s = await updateStatus(ctx, true, T0);
	assert.equal(ctx.calls.length, 1);
	assert.equal(ctx.calls[0].url, DIST_TAGS_URL);
	assert.equal(DIST_TAGS_URL, "https://registry.npmjs.org/-/package/%40coywolf%2Femdash/dist-tags");
	assert.deepEqual({ enabled: s.enabled, current: s.current, latest: s.latest, available: s.available, command: s.command }, { enabled: true, current: VERSION, latest: "99.0.0", available: true, command: UPDATE_COMMAND });
	assert.equal(UPDATE_COMMAND, "npm install @coywolf/emdash@latest");
});

test("the same version isn't an update", async () => {
	const s = await updateStatus(fakeCtx({ body: { latest: VERSION } }), true, T0);
	assert.equal(s.available, false);
});

test("asks at most once a day", async () => {
	let latest = "99.0.0";
	const ctx = fakeCtx(() => ({ body: { latest } }));
	await updateStatus(ctx, true, T0);
	latest = "99.1.0";
	const later = await updateStatus(ctx, true, T0 + DAY - 1);
	assert.equal(ctx.calls.length, 1);
	assert.equal(later.latest, "99.0.0");
	const nextDay = await updateStatus(ctx, true, T0 + DAY);
	assert.equal(ctx.calls.length, 2);
	assert.equal(nextDay.latest, "99.1.0");
});

test("a failed check keeps the last answer and waits six hours", async () => {
	let fail = false;
	const ctx = fakeCtx(() => (fail ? new Error("offline") : { body: { latest: "99.0.0" } }));
	await updateStatus(ctx, true, T0);
	fail = true;
	const failed = await updateStatus(ctx, true, T0 + DAY);
	assert.equal(ctx.calls.length, 2);
	assert.equal(failed.latest, "99.0.0", "the last answer still shows");
	assert.equal(failed.available, true);
	await updateStatus(ctx, true, T0 + DAY + 6 * 3_600_000 - 1);
	assert.equal(ctx.calls.length, 2, "no new request within six hours of a failure");
	fail = false;
	await updateStatus(ctx, true, T0 + DAY + 6 * 3_600_000);
	assert.equal(ctx.calls.length, 3);
});

test("npm errors and malformed answers show no update", async () => {
	for (const answer of [{ status: 404, body: { error: "Not found" } }, { body: { latest: "not-a-version" } }, { body: {} }, "<html>"]) {
		const s = await updateStatus(fakeCtx(answer), true, T0);
		assert.equal(s.available, false, JSON.stringify(answer));
		assert.equal(s.latest, null);
	}
});

test("nothing is asked while the check is off", async () => {
	const ctx = fakeCtx({ body: { latest: "99.0.0" } });
	assert.deepEqual(await updateStatus(ctx, false, T0), { enabled: false, current: VERSION });
	assert.equal(ctx.calls.length, 0);
});

test("the update check starts off, can be left out, and may reach npm", () => {
	const pack = readFileSync(new URL("../src/updates/pack.ts", import.meta.url), "utf8");
	assert.match(pack, /id: "updates",[\s\S]*?default: false/);
	assert.match(pack, /allowedHosts: \[NPM_HOST\]/);
	const modules = readFileSync(new URL("../src/modules.ts", import.meta.url), "utf8");
	assert.match(modules, /o\.updates === false \? null : updatesPack\(\)/);
});

test("every pack page and the usage widget carry the notice", () => {
	const admin = readFileSync(new URL("../src/admin/index.tsx", import.meta.url), "utf8");
	assert.match(admin, /export const pages[^=]*= Object\.fromEntries\(Object\.entries\(PAGES\)\.map\(\(\[path, Page\]\) => \[path, withUpdateNotice\(Page\)\]\)\)/);
	assert.match(admin, /"cloudflare-usage": withUpdateLine\(UsageWidget\)/);
});

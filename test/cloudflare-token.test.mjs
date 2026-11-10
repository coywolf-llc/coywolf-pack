// Run: node --test test/cloudflare-token.test.mjs
//
// The one Cloudflare API token (src/core/cloudflare-token.ts): which token each feature uses and in what order,
// which account it works in, the R2 S3 keys made from it, and the Features page's routes that report on it and
// remove the older tokens (src/core/cloudflare-token-routes.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

import "./ts-resolve.mjs";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: "data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = () => {};", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

// A developer's own shell may export these; the tests pass every Worker variable explicitly.
for (const name of ["CLOUDFLARE_API_TOKEN", "CF_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "USAGE_API_TOKEN", "IMAGES_API_TOKEN", "CF_STREAM_TOKEN", "BROWSER_RUN_API_TOKEN", "RADAR_API_TOKEN", "BACKUPS_API_TOKEN"]) delete process.env[name];

const T = await import("../src/core/cloudflare-token.ts");
const { cloudflareTokenRoutes, cloudflareTokenStatus, OLDER_TOKEN_SETTINGS } = await import("../src/core/cloudflare-token-routes.ts");

const ACCOUNT = "a".repeat(32);

function fakeCtx(settings = {}, { unreadable = [], fetch } = {}) {
	const stored = new Map(Object.entries(settings));
	const kv = new Map();
	const logs = [];
	return {
		settings: {
			get: async (k) => {
				if (unreadable.includes(k)) throw new Error("PluginSettingEncryptionError");
				return stored.get(k) ?? null;
			},
			set: async (k, v) => void stored.set(k, v),
			delete: async (k) => void stored.delete(k),
		},
		kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
		log: { info: (m, d) => logs.push([m, d]), warn() {}, error() {} },
		...(fetch ? { http: { fetch } } : {}),
		stored,
		kvMap: kv,
		logs,
	};
}

/** Cloudflare's API in memory: `routes` maps "METHOD /path" to a result (or a function of the request). */
function cloudflare(routes = {}) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		const path = url.replace("https://api.cloudflare.com/client/v4", "");
		const key = `${init.method ?? "GET"} ${path}`;
		calls.push({ key, auth: init.headers?.Authorization });
		const route = routes[key];
		if (route === undefined) return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${key}` }] }), { status: 404 });
		const result = typeof route === "function" ? route(init) : route;
		if (result instanceof Response) return result;
		return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
	};
	return { fetch, calls };
}

beforeEach(() => {
	T.resetAccountMisses();
	globalThis.__testEnv = {};
});

// ── Which token ──────────────────────────────────────────────

test("each feature's order: typed, the Cloudflare API token, its older saved token, its older Worker secret, then CLOUDFLARE_API_TOKEN", async () => {
	for (const [feature, older] of Object.entries(T.OLDER_TOKENS)) {
		const all = { cloudflareApiToken: "shared", ...(older.setting ? { [older.setting]: "older" } : {}) };
		const env = { CLOUDFLARE_API_TOKEN: "shared-env", ...Object.fromEntries(older.env.map((n) => [n, `env:${n}`])) };
		const pick = async (settings, e, o) => {
			const r = await T.cloudflareToken(fakeCtx(settings), e, feature, o);
			return [r.token, r.source];
		};
		assert.deepEqual(await pick(all, env, { typed: " typed " }), ["typed", "typed"], feature);
		assert.deepEqual(await pick(all, env), ["shared", "shared"], `${feature}: the new token wins once saved`);
		if (older.setting) assert.deepEqual(await pick({ [older.setting]: " older " }, env), ["older", "older"], `${feature}: the older saved token still works alone`);
		if (older.env.length) assert.deepEqual(await pick({}, env), [`env:${older.env[0]}`, "older-env"], `${feature}: the older Worker secret ranks above CLOUDFLARE_API_TOKEN`);
		assert.deepEqual(await pick({}, { CLOUDFLARE_API_TOKEN: "shared-env" }), ["shared-env", "shared-env"], feature);
		assert.deepEqual(await pick({}, {}), [null, null], feature);
	}
});

test("Backups names its own older secret; restores' token never comes from here", async () => {
	const env = { BACKUPS_API_TOKEN: "restore", MY_TOKEN: "mine", CLOUDFLARE_API_TOKEN: "shared-env" };
	assert.equal((await T.cloudflareToken(fakeCtx(), env, "backupsRetention", { olderEnv: ["MY_TOKEN"] })).token, "mine");
	assert.equal((await T.cloudflareToken(fakeCtx(), { CLOUDFLARE_API_TOKEN: "shared-env" }, "backupsRetention", { olderEnv: ["MY_TOKEN"] })).token, "shared-env");
	// Without olderEnv the feature's own list applies, which doesn't include the restore token.
	assert.equal((await T.cloudflareToken(fakeCtx(), env, "backupsRetention")).token, "shared-env");
	assert.ok(!T.OLDER_TOKEN_SECRETS.includes("BACKUPS_API_TOKEN"));
});

test("a saved token that can't be decrypted is skipped and reported, never thrown", async () => {
	const ctx = fakeCtx({ usageApiToken: "older" }, { unreadable: ["cloudflareApiToken"] });
	assert.deepEqual(await T.cloudflareToken(ctx, {}, "read"), { token: "older", source: "older", unreadable: true });
	const none = await T.cloudflareToken(fakeCtx({}, { unreadable: ["cloudflareApiToken", "usageApiToken"] }), {}, "read");
	assert.deepEqual(none, { token: null, source: null, unreadable: true });
	assert.deepEqual(T.sharedTokenState({ source: "shared" }), { sharedToken: true, sharedTokenEnv: false });
	assert.deepEqual(T.sharedTokenState({ source: "shared-env" }), { sharedToken: true, sharedTokenEnv: true });
	assert.deepEqual(T.sharedTokenState({ source: "older" }), { sharedToken: false, sharedTokenEnv: false });
});

// ── Which account ────────────────────────────────────────────

test("the account: the override, then CF_ACCOUNT_ID, Clean Image URLs' account, a zone's hint, then the token's only account", async () => {
	const cf = cloudflare({ "GET /accounts?per_page=5": [{ id: "found" }] });
	const a = { token: "tok", fetch: cf.fetch };
	assert.equal(await T.cloudflareAccountId(fakeCtx({ imagesAccountId: "images" }), { CF_ACCOUNT_ID: "env" }, a, " own "), "own");
	assert.equal(await T.cloudflareAccountId(fakeCtx({ imagesAccountId: "images" }), { CLOUDFLARE_ACCOUNT_ID: "env2" }, a), "env2");
	assert.equal(await T.cloudflareAccountId(fakeCtx({ imagesAccountId: "images" }), {}, a, null, { hint: "zone" }), "images");
	assert.equal(await T.cloudflareAccountId(fakeCtx(), {}, a, null, { hint: "zone" }), "zone");
	assert.equal(cf.calls.length, 0, "none of those asks Cloudflare");
	assert.equal(await T.cloudflareAccountId(fakeCtx(), {}, a), "found");
	assert.equal(cf.calls[0].auth, "Bearer tok");
});

test("the token's account is remembered for that token only; more than one account is no answer, asked again only later", async () => {
	const cf = cloudflare({ "GET /accounts?per_page=5": [{ id: ACCOUNT }] });
	const ctx = fakeCtx();
	assert.equal(await T.cloudflareAccountId(ctx, {}, { token: "tok-1", fetch: cf.fetch }), ACCOUNT);
	assert.equal(await T.cloudflareAccountId(ctx, {}, { token: "tok-1", fetch: cf.fetch }), ACCOUNT);
	assert.equal(cf.calls.length, 1, "remembered");
	assert.equal(await T.cloudflareAccountId(ctx, {}, { token: "tok-2", fetch: cf.fetch }, null, { lookup: false }), null, "another token's account isn't reused");
	assert.equal(cf.calls.length, 1);
	assert.ok(!JSON.stringify([...ctx.kvMap.values()]).includes("tok-1"), "the token itself isn't stored");

	const many = cloudflare({ "GET /accounts?per_page=5": [{ id: "x" }, { id: "y" }] });
	assert.equal(await T.cloudflareAccountId(fakeCtx(), {}, { token: "tok-3", fetch: many.fetch }), null);
	assert.equal(await T.cloudflareAccountId(fakeCtx(), {}, { token: "tok-3", fetch: many.fetch }), null);
	assert.equal(many.calls.length, 1, "a miss isn't asked again right away");
	T.resetAccountMisses();
	await T.cloudflareAccountId(fakeCtx(), {}, { token: "tok-3", fetch: many.fetch });
	assert.equal(many.calls.length, 2);
	assert.match(T.noAccountMessage("Advanced"), /more than one account.*Enter the account ID under Advanced/);
});

// ── R2 keys from the token ───────────────────────────────────

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("R2 keys: the access key ID is the token's ID, the secret its SHA-256 in hex", async () => {
	assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "the test's own hash is right");
	const cf = cloudflare({ "GET /user/tokens/verify": { id: "token-id-1", status: "active" } });
	const ctx = fakeCtx();
	const keys = await T.r2S3Credentials(ctx, { token: "abc", fetch: cf.fetch, accountId: ACCOUNT });
	assert.deepEqual(keys, { accessKeyId: "token-id-1", secretAccessKey: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
	// The ID is remembered; the secret is never stored.
	assert.deepEqual(await T.r2S3Credentials(ctx, { token: "abc", fetch: cf.fetch, accountId: ACCOUNT }), keys);
	assert.equal(cf.calls.length, 1);
	assert.ok(!JSON.stringify([...ctx.kvMap.values()]).includes(keys.secretAccessKey.slice(0, 16)));
	// The fingerprint the remembered values carry is no part of the secret.
	const fp = await T.tokenFingerprint("abc");
	assert.ok(!keys.secretAccessKey.includes(fp));
});

test("R2 keys: an account token (cfat_) asks the account's verify endpoint first; any other token the user's; each falls back to the other", async () => {
	const account = cloudflare({ [`GET /accounts/${ACCOUNT}/tokens/verify`]: { id: "acct-token", status: "active" }, "GET /user/tokens/verify": { id: "wrong" } });
	assert.equal((await T.r2S3Credentials(fakeCtx(), { token: "cfat_example", fetch: account.fetch, accountId: ACCOUNT })).accessKeyId, "acct-token");
	assert.deepEqual(account.calls.map((c) => c.key), [`GET /accounts/${ACCOUNT}/tokens/verify`]);

	// An account token from before the cfat_ prefix: the user endpoint refuses it, the account's answers.
	const legacy = cloudflare({ [`GET /accounts/${ACCOUNT}/tokens/verify`]: { id: "legacy-id", status: "active" } });
	assert.equal((await T.r2S3Credentials(fakeCtx(), { token: "legacyAccountToken", fetch: legacy.fetch, accountId: ACCOUNT })).accessKeyId, "legacy-id");
	assert.deepEqual(legacy.calls.map((c) => c.key), ["GET /user/tokens/verify", `GET /accounts/${ACCOUNT}/tokens/verify`]);

	const disabled = cloudflare({ "GET /user/tokens/verify": { id: "x", status: "disabled" } });
	assert.equal(await T.r2S3Credentials(fakeCtx(), { token: "tok", fetch: disabled.fetch, accountId: ACCOUNT }), null);
});

test("large uploads: a complete saved key pair wins; otherwise keys from the Cloudflare API token, and the bucket is always needed", async () => {
	const { r2Config } = await import("../src/files/module.ts");
	const cf = cloudflare({ "GET /user/tokens/verify": { id: "tid", status: "active" }, "GET /accounts?per_page=5": [{ id: ACCOUNT }] });
	const pair = { filesR2AccountId: ACCOUNT, filesR2AccessKeyId: "AKID", filesR2SecretAccessKey: "SECRET", filesR2Bucket: "coywolf-media" };
	assert.deepEqual(await r2Config(fakeCtx({ ...pair, cloudflareApiToken: "tok" }, { fetch: cf.fetch }), {}), { accountId: ACCOUNT, accessKeyId: "AKID", secretAccessKey: "SECRET", bucket: "coywolf-media" });
	assert.equal(cf.calls.length, 0, "the saved pair needs no call");

	const derived = await r2Config(fakeCtx({ filesR2Bucket: "coywolf-media", cloudflareApiToken: "tok" }, { fetch: cf.fetch }), {});
	assert.deepEqual(derived, { accountId: ACCOUNT, accessKeyId: "tid", secretAccessKey: sha256("tok"), bucket: "coywolf-media" });
	// The CLOUDFLARE_API_TOKEN Worker secret works the same way; no other feature's older token does.
	assert.equal((await r2Config(fakeCtx({ filesR2Bucket: "coywolf-media", filesR2AccountId: ACCOUNT }, { fetch: cf.fetch }), { CLOUDFLARE_API_TOKEN: "envtok" })).secretAccessKey, sha256("envtok"));
	await assert.rejects(r2Config(fakeCtx({ filesR2Bucket: "coywolf-media", usageApiToken: "old" }, { fetch: cf.fetch }), {}), /add the Cloudflare API token/);
	await assert.rejects(r2Config(fakeCtx({ cloudflareApiToken: "tok" }, { fetch: cf.fetch }), {}), /enter the R2 bucket name/);
	// A half-saved pair doesn't count: the token stands in.
	assert.equal((await r2Config(fakeCtx({ filesR2Bucket: "coywolf-media", filesR2AccessKeyId: "AKID", cloudflareApiToken: "tok" }, { fetch: cf.fetch }), {})).accessKeyId, "tid");
});

// ── The Features page's routes ───────────────────────────────

test("status: the token, its remembered account, the older tokens still saved and the older Worker secrets set; it asks Cloudflare nothing", async () => {
	const ctx = fakeCtx({ cloudflareApiToken: "tok", videosApiToken: "v", robotsRadarToken: "r", filesR2AccessKeyId: "AKID" }, { unreadable: ["imagesApiToken"] });
	const status = await cloudflareTokenStatus(ctx, { CF_STREAM_TOKEN: "x", BACKUPS_API_TOKEN: "restore", CF_ACCOUNT_ID: ACCOUNT });
	assert.equal(status.saved, true);
	assert.equal(status.accountId, ACCOUNT);
	assert.deepEqual(status.older.map((o) => o.key).sort(), ["imagesApiToken", "robotsRadarToken", "videosApiToken"], "an unreadable one is still there to remove");
	assert.ok(status.older.every((o) => !o.label.startsWith("Older:")));
	assert.equal(status.r2KeyPair, true);
	assert.deepEqual(status.olderSecrets, ["CF_STREAM_TOKEN"], "the restore token isn't an older token");
	assert.equal(ctx.http, undefined);
});

test("clear-older: only once the Cloudflare API token is there; the R2 key pair only when asked", async () => {
	const { "cloudflare-token/clear-older": route } = cloudflareTokenRoutes();
	const older = Object.fromEntries(OLDER_TOKEN_SETTINGS.map((k) => [k, "old"]));
	const pair = { filesR2SecretAccessKey: "S", filesR2AccessKeyId: "AKID", filesR2Bucket: "b", filesR2AccountId: ACCOUNT };

	const before = fakeCtx({ ...older });
	await assert.rejects(route.handler({ ...before, input: {} }), /Save the Cloudflare API token/);
	assert.equal(before.stored.size, OLDER_TOKEN_SETTINGS.length, "nothing removed");

	const ctx = fakeCtx({ ...older, ...pair, cloudflareApiToken: "tok", aiApiKey: "ai" });
	const result = await route.handler({ ...ctx, input: {} });
	assert.equal(result.removed, OLDER_TOKEN_SETTINGS.length);
	for (const k of OLDER_TOKEN_SETTINGS) assert.ok(!ctx.stored.has(k), k);
	assert.equal(ctx.stored.get("cloudflareApiToken"), "tok");
	assert.equal(ctx.stored.get("aiApiKey"), "ai");
	assert.equal(ctx.stored.get("filesR2SecretAccessKey"), "S", "the R2 pair stays unless asked");
	assert.deepEqual(result.status.older, []);

	await route.handler({ ...ctx, input: { r2: true } });
	assert.ok(!ctx.stored.has("filesR2SecretAccessKey") && !ctx.stored.has("filesR2AccessKeyId"));
	assert.equal(ctx.stored.get("filesR2Bucket"), "b", "the bucket name is still needed");

	// The Worker secret counts as the token being there.
	globalThis.__testEnv = { CLOUDFLARE_API_TOKEN: "env" };
	const viaEnv = fakeCtx({ usageApiToken: "old" });
	assert.equal((await route.handler({ ...viaEnv, input: {} })).removed, 1);
});

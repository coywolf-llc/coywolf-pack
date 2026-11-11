// Run: node --test test/bucket-detect.test.mjs
//
// Bucket names from the site Worker's own bindings (src/core/worker-bindings.ts): the Worker whose deployment
// runs this version, its R2 bindings from the script's settings, remembered per Worker version and token; and
// the three features that use them (large uploads, Set up media host, Retention on Cloudflare), where a saved
// bucket name always wins.
import assert from "node:assert/strict";
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
for (const name of ["CLOUDFLARE_API_TOKEN", "CF_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "USAGE_API_TOKEN", "IMAGES_API_TOKEN", "BACKUPS_API_TOKEN"]) delete process.env[name];

const W = await import("../src/core/worker-bindings.ts");
const T = await import("../src/core/cloudflare-token.ts");

const ACCOUNT = "a".repeat(32);
const VERSION = "v-123";
const env = (over = {}) => ({ CF_VERSION_METADATA: { id: VERSION }, ...over });

/** coywolf.com's bindings, as the settings endpoint returns them (wrangler.jsonc's r2_buckets). */
const COYWOLF_BINDINGS = [
	{ type: "d1", name: "DB", database_id: "db1" },
	{ type: "r2_bucket", name: "MEDIA", bucket_name: "coywolf-staging-media" },
	{ type: "r2_bucket", name: "BACKUPS", bucket_name: "coywolf-staging-backups" },
	{ type: "r2_bucket", name: "FORM_UPLOADS", bucket_name: "coywolf-eu-uploads", jurisdiction: "eu" },
	{ type: "version_metadata", name: "CF_VERSION_METADATA" },
];

const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const refused = (status = 403) => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status });

/**
 * Cloudflare's API in memory: the account, two Workers (the site's `coywolf`, and `other` deployed later), their
 * deployments and coywolf's settings. `over` replaces a path's answer ("METHOD /path" or "/path").
 */
function cloudflare(over = {}, { bindings = COYWOLF_BINDINGS, version = VERSION } = {}) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		const path = `${u.pathname.replace("/client/v4", "")}${u.search}`;
		const method = init.method ?? "GET";
		calls.push({ key: `${method} ${path}`, path, auth: init.headers?.Authorization });
		const route = over[`${method} ${path}`] ?? over[path];
		if (route) return route(init);
		if (path === "/accounts?per_page=5") return ok([{ id: ACCOUNT }]);
		if (path === `/accounts/${ACCOUNT}/workers/scripts`) return ok([{ id: "coywolf", modified_on: "2026-11-01T00:00:00Z" }, { id: "other", modified_on: "2026-11-09T00:00:00Z" }]);
		if (path === `/accounts/${ACCOUNT}/workers/scripts/coywolf/deployments`) return ok({ deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] });
		if (path === `/accounts/${ACCOUNT}/workers/scripts/other/deployments`) return ok({ deployments: [{ versions: [{ version_id: "v-other", percentage: 100 }] }] });
		if (path === `/accounts/${ACCOUNT}/workers/scripts/coywolf/settings`) return ok({ bindings });
		return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }] }), { status: 404 });
	};
	const workerCalls = () => calls.filter((c) => c.path.includes("/workers/"));
	return { fetch, calls, workerCalls };
}

function fakeCtx(settings = {}, fetch) {
	const stored = new Map(Object.entries(settings));
	const kv = new Map();
	const logs = [];
	return {
		settings: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => void stored.set(k, v), delete: async (k) => void stored.delete(k) },
		kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
		log: { info: (m, d) => logs.push(["info", m, d]), warn: (m, d) => logs.push(["warn", m, d]), error() {} },
		cron: { schedule: async () => {} },
		site: { url: "https://coywolf.com/" },
		...(fetch ? { http: { fetch } } : {}),
		stored,
		kvMap: kv,
		logs,
	};
}

const access = (cf, token = "tok") => ({ token, fetch: cf.fetch, accountId: ACCOUNT });

beforeEach(() => {
	W.resetBucketMisses();
	T.resetAccountMisses();
	globalThis.__testEnv = undefined;
});

// ── Detection ────────────────────────────────────────────────

test("the bucket bound as MEDIA or BACKUPS comes from the Worker whose deployment runs this version", async () => {
	const cf = cloudflare();
	const ctx = fakeCtx();
	const media = await W.boundBucket(ctx, env(), "MEDIA", access(cf));
	assert.deepEqual(media, { binding: "MEDIA", bucket: "coywolf-staging-media", jurisdiction: null, worker: "coywolf", miss: null, message: null });
	// "other" was deployed later, so it's checked first, but it runs another version.
	assert.deepEqual(
		cf.calls.map((c) => c.key),
		[`GET /accounts/${ACCOUNT}/workers/scripts`, `GET /accounts/${ACCOUNT}/workers/scripts/other/deployments`, `GET /accounts/${ACCOUNT}/workers/scripts/coywolf/deployments`, `GET /accounts/${ACCOUNT}/workers/scripts/coywolf/settings`],
	);
	assert.ok(cf.calls.every((c) => c.auth === "Bearer tok"));

	// Every R2 binding was kept from that one read.
	assert.equal((await W.boundBucket(ctx, env(), "BACKUPS", access(cf))).bucket, "coywolf-staging-backups");
	const uploads = await W.boundBucket(ctx, env(), "FORM_UPLOADS", access(cf));
	assert.deepEqual([uploads.bucket, uploads.jurisdiction], ["coywolf-eu-uploads", "eu"], "a jurisdiction is noted");
	const none = await W.boundBucket(ctx, env(), "FILES", access(cf));
	assert.deepEqual([none.bucket, none.miss], [null, "no-binding"]);
	assert.match(none.message, /coywolf\) has no R2 binding named FILES/);
	assert.equal(cf.calls.length, 4, "the later lookups asked Cloudflare nothing");
	assert.ok(!JSON.stringify([...ctx.kvMap.values()]).includes("tok"), "the token itself isn't stored");
});

test("remembered per Worker version and token: a deploy reads the bindings again, starting with the Worker found before", async () => {
	const cf = cloudflare();
	const ctx = fakeCtx();
	assert.equal((await W.boundBucket(ctx, env(), "MEDIA", access(cf))).bucket, "coywolf-staging-media");
	const first = cf.calls.length;
	assert.equal((await W.boundBucket(ctx, env(), "MEDIA", access(cf))).bucket, "coywolf-staging-media");
	assert.equal(cf.calls.length, first, "same version and token: nothing asked");

	// A deploy that changed wrangler.jsonc: a new version, a new bucket.
	const deployed = cloudflare({}, { version: "v-456", bindings: [{ type: "r2_bucket", name: "MEDIA", bucket_name: "coywolf-media-2" }] });
	assert.equal((await W.boundBucket(ctx, env({ CF_VERSION_METADATA: { id: "v-456" } }), "MEDIA", access(deployed))).bucket, "coywolf-media-2");
	assert.deepEqual(
		deployed.calls.map((c) => c.key),
		[`GET /accounts/${ACCOUNT}/workers/scripts/coywolf/deployments`, `GET /accounts/${ACCOUNT}/workers/scripts/coywolf/settings`],
		"the Worker found for the last version is checked first, so the scan is skipped",
	);

	// Another token doesn't reuse what this one found.
	const other = cloudflare();
	assert.equal((await W.boundBucket(ctx, env(), "MEDIA", access(other, "tok-2"))).bucket, "coywolf-staging-media");
	assert.ok(other.calls.some((c) => c.key === `GET /accounts/${ACCOUNT}/workers/scripts`), "looked up again for the other token");
	assert.ok(other.calls.every((c) => c.auth === "Bearer tok-2"));
});

test("a Cloudflare that didn't answer isn't remembered: asked again next time", async () => {
	let settingsCalls = 0;
	const flaky = cloudflare({
		[`/accounts/${ACCOUNT}/workers/scripts/coywolf/settings`]: () => (++settingsCalls === 1 ? new Response(JSON.stringify({ success: false, errors: [{ code: 10013, message: "Internal error" }] }), { status: 500 }) : ok({ bindings: COYWOLF_BINDINGS })),
	});
	const ctx = fakeCtx();
	const failed = await W.boundBucket(ctx, env(), "MEDIA", access(flaky));
	assert.deepEqual([failed.bucket, failed.miss], [null, "unavailable"]);
	assert.match(failed.message, /Cloudflare didn't answer \(Cloudflare API 500: Internal error\)/);
	assert.equal(ctx.kvMap.size, 0, "nothing remembered");
	assert.equal((await W.boundBucket(ctx, env(), "MEDIA", access(flaky))).bucket, "coywolf-staging-media");
	assert.equal(settingsCalls, 2);

	// A network error the same way.
	let down = true;
	const network = cloudflare({ [`/accounts/${ACCOUNT}/workers/scripts`]: () => (down ? Promise.reject(new TypeError("network connection lost")) : ok([{ id: "coywolf" }])) });
	const ctx2 = fakeCtx();
	assert.equal((await W.boundBucket(ctx2, env(), "MEDIA", access(network))).miss, "unavailable");
	down = false;
	assert.equal((await W.boundBucket(ctx2, env(), "MEDIA", access(network))).bucket, "coywolf-staging-media");
});

test("a token without Workers read access is named with the editor's permission, and isn't remembered either", async () => {
	let allowed = false;
	const cf = cloudflare({ [`/accounts/${ACCOUNT}/workers/scripts`]: () => (allowed ? ok([{ id: "coywolf" }]) : refused()) });
	const ctx = fakeCtx();
	const lookup = await W.boundBucket(ctx, env(), "MEDIA", { ...access(cf), tokenName: "Cloudflare API token" });
	assert.deepEqual([lookup.bucket, lookup.miss], [null, "forbidden"]);
	assert.equal(lookup.message, "The Cloudflare API token can't read this site's Worker: it needs Workers → Metadata Read-Only.");
	// The permission added in Cloudflare's dashboard: the next look finds it (the token itself didn't change).
	allowed = true;
	assert.equal((await W.boundBucket(ctx, env(), "MEDIA", access(cf))).bucket, "coywolf-staging-media");
});

test("a Worker that isn't found is looked for again only after a while (per isolate); without CF_VERSION_METADATA nothing is asked", async () => {
	const cf = cloudflare({}, { version: "v-elsewhere" });
	const ctx = fakeCtx();
	const lookup = await W.boundBucket(ctx, env(), "MEDIA", access(cf));
	assert.deepEqual([lookup.bucket, lookup.miss], [null, "not-found"]);
	const scans = cf.calls.length;
	assert.equal((await W.boundBucket(ctx, env(), "MEDIA", access(cf))).miss, "not-found");
	assert.equal(cf.calls.length, scans, "not scanned again right away");
	assert.equal(ctx.kvMap.size, 0, "a miss isn't stored in KV");
	W.resetBucketMisses();
	await W.boundBucket(ctx, env(), "MEDIA", access(cf));
	assert.ok(cf.calls.length > scans);

	const none = cloudflare();
	assert.equal((await W.boundBucket(fakeCtx(), {}, "MEDIA", access(none))).miss, "no-version");
	assert.equal((await W.findBoundBucket(fakeCtx(), {}, "MEDIA", { resolved: { token: "tok", source: "shared", from: "cloudflareApiToken", unreadable: false }, fetch: none.fetch })).miss, "no-version");
	assert.equal(none.calls.length, 0, "not even the account");
	const noToken = await W.findBoundBucket(fakeCtx(), env(), "MEDIA", { resolved: { token: null, source: null, from: null, unreadable: false }, fetch: none.fetch });
	assert.equal(noToken.miss, "no-token");
	assert.match(noToken.message, /Add the Cloudflare API token.*Workers → Metadata Read-Only/);
});

test("usage finds the D1 database with the same lookups", async () => {
	const cf = cloudflare();
	const { usageReport } = await import("../src/pageCache/usage.ts");
	const ctx = fakeCtx({ cloudflareApiToken: "tok" }, async (url, init) => {
		if (url.endsWith("/graphql")) return new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } }, errors: null }), { status: 200 });
		return cf.fetch(url, init);
	});
	const report = await usageReport(ctx, false, env());
	assert.equal(report.worker, "coywolf");
	assert.equal(report.databaseId, "db1");
});

// ── Large uploads ────────────────────────────────────────────

test("large uploads use the bucket bound as MEDIA (or FILES); a saved bucket name wins and skips the lookup", async () => {
	const { r2Config, r2Readiness } = await import("../src/files/module.ts");
	const cf = cloudflare({ "/user/tokens/verify": () => ok({ id: "tid", status: "active" }) });
	const detected = await r2Config(fakeCtx({ cloudflareApiToken: "tok" }, cf.fetch), env());
	assert.equal(detected.bucket, "coywolf-staging-media");
	assert.equal(detected.accessKeyId, "tid");

	// Large uploads in their own bucket: bound as FILES.
	const filesCf = cloudflare({ "/user/tokens/verify": () => ok({ id: "tid", status: "active" }) }, { bindings: [...COYWOLF_BINDINGS, { type: "r2_bucket", name: "FILES", bucket_name: "coywolf-files" }] });
	assert.equal((await r2Config(fakeCtx({ cloudflareApiToken: "tok" }, filesCf.fetch), env({ FILES: {} }))).bucket, "coywolf-files");

	// A saved name wins, as before: Cloudflare isn't asked about the Worker.
	const saved = cloudflare({ "/user/tokens/verify": () => ok({ id: "tid", status: "active" }) });
	assert.equal((await r2Config(fakeCtx({ cloudflareApiToken: "tok", filesR2Bucket: "my-override" }, saved.fetch), env())).bucket, "my-override");
	assert.deepEqual(saved.workerCalls(), []);
	assert.deepEqual(await r2Readiness(fakeCtx({ cloudflareApiToken: "tok", filesR2Bucket: "my-override" }, saved.fetch), env()), { configured: true, problem: null });
	assert.deepEqual(saved.workerCalls(), []);

	// A complete key pair saved without a bucket name: its own keys, with the bound bucket.
	const pair = { filesR2AccountId: ACCOUNT, filesR2AccessKeyId: "AKID", filesR2SecretAccessKey: "SECRET" };
	assert.deepEqual(await r2Config(fakeCtx({ ...pair, cloudflareApiToken: "tok" }, cloudflare().fetch), env()), { accountId: ACCOUNT, accessKeyId: "AKID", secretAccessKey: "SECRET", bucket: "coywolf-staging-media" });

	// Ready once the bucket is found; why not, when it isn't.
	assert.deepEqual(await r2Readiness(fakeCtx({ cloudflareApiToken: "tok" }, cloudflare().fetch), env()), { configured: true, problem: null });
	const forbidden = cloudflare({ [`/accounts/${ACCOUNT}/workers/scripts`]: () => refused() });
	const notReady = await r2Readiness(fakeCtx({ cloudflareApiToken: "tok" }, forbidden.fetch), env());
	assert.equal(notReady.configured, false);
	assert.match(notReady.bucketReason, /needs Workers → Metadata Read-Only/);
	await assert.rejects(r2Config(fakeCtx({ cloudflareApiToken: "tok" }, forbidden.fetch), env()), /enter the R2 bucket name on the Files page → Settings\. The pack couldn't find it from the MEDIA binding\. The Cloudflare API token can't read/);
});

test("large uploads refuse a bucket in a jurisdiction with a clear message", async () => {
	const { r2Config, r2Readiness } = await import("../src/files/module.ts");
	const eu = cloudflare({}, { bindings: [{ type: "r2_bucket", name: "MEDIA", bucket_name: "coywolf-eu-media", jurisdiction: "eu" }] });
	await assert.rejects(r2Config(fakeCtx({ cloudflareApiToken: "tok" }, eu.fetch), env()), /MEDIA binding's bucket coywolf-eu-media is in the eu jurisdiction, which large uploads can't use yet\. Bind a bucket without a jurisdiction as FILES/);
	const ready = await r2Readiness(fakeCtx({ cloudflareApiToken: "tok" }, eu.fetch), env());
	assert.equal(ready.configured, false);
	assert.match(ready.problem, /eu jurisdiction/);
});

test("the Files settings show the bucket found, and why not when it isn't", async () => {
	await import("../src/files/pack.ts"); // registers the files feature
	const { filesModule } = await import("../src/files/module.ts");
	const settings = filesModule({}).routes["files/settings"];
	const withFeatures = (s, fetch) => fakeCtx({ features: { files: true }, ...s }, fetch);
	globalThis.__testEnv = env();
	try {
		const found = await settings.handler(withFeatures({ cloudflareApiToken: "tok" }, cloudflare().fetch));
		assert.deepEqual([found.detectedBucket.bucket, found.detectedBucket.binding, found.filesR2Bucket], ["coywolf-staging-media", "MEDIA", ""]);
		const none = await settings.handler(withFeatures({}, cloudflare().fetch));
		assert.equal(none.detectedBucket.miss, "no-token");
	} finally {
		globalThis.__testEnv = undefined;
	}
});

// ── Set up media host ────────────────────────────────────────

/** Cloudflare for the media host setup too: the zone and the R2 bucket's custom domains. */
const withZone = (over = {}) =>
	cloudflare({
		[`/zones?name=coywolf.com&account.id=${ACCOUNT}`]: () => ok([{ id: "z1", name: "coywolf.com" }]),
		"/zones/z1/settings/transformations": () => ok({ value: "on" }),
		"/zones/z1/rulesets/phases/http_request_transform/entrypoint": () => ok({ rules: [] }),
		"/zones/z1/cache/tiered_cache_smart_topology_enable": () => ok({ value: "on" }),
		...over,
	});
const domainsCalls = (cf) => cf.calls.filter((c) => c.path.includes("/r2/buckets/")).map((c) => c.path.split("/r2/buckets/")[1].split("/")[0]);

test("Set up media host uses the bucket bound as MEDIA; a typed or saved name wins and skips the lookup", async () => {
	await import("../src/images/pack.ts"); // registers the images feature
	const { imagesModule } = await import("../src/images/module.ts");
	const routes = imagesModule({ variants: { start: async () => null, deps: async () => null } }).routes;
	const plan = (cf, settings = {}, input = {}) => routes["images/setup/plan"].handler({ ...fakeCtx({ features: { images: true }, cloudflareApiToken: "tok", ...settings }, cf.fetch), input: { host: "https://media.coywolf.com", ...input } });
	const domains = (bucket) => ({ [`/accounts/${ACCOUNT}/r2/buckets/${bucket}/domains/custom`]: () => ok({ domains: [] }) });
	globalThis.__testEnv = env();
	try {
		const found = withZone(domains("coywolf-staging-media"));
		const result = await plan(found);
		assert.equal(result.zone, "coywolf.com");
		assert.deepEqual(domainsCalls(found), ["coywolf-staging-media"], "the plan reads the bound bucket's custom domains");

		const saved = withZone(domains("my-media"));
		await plan(saved, { imagesBucketName: "my-media" });
		assert.deepEqual(domainsCalls(saved), ["my-media"]);
		assert.deepEqual(saved.workerCalls(), [], "a saved name: no lookup");

		const typed = withZone(domains("typed-media"));
		await plan(typed, { imagesBucketName: "my-media" }, { bucket: "typed-media" });
		assert.deepEqual(domainsCalls(typed), ["typed-media"]);
		assert.deepEqual(typed.workerCalls(), []);

		// No bucket found and none entered: the old message, with why.
		const forbidden = withZone({ [`/accounts/${ACCOUNT}/workers/scripts`]: () => refused() });
		await assert.rejects(plan(forbidden), /Enter the R2 bucket name first\. The pack couldn't find it from the MEDIA binding\. The Cloudflare API token can't read this site's Worker: it needs Workers → Metadata Read-Only\.$/);
		const eu = cloudflare({}, { bindings: [{ type: "r2_bucket", name: "MEDIA", bucket_name: "eu-media", jurisdiction: "eu" }] });
		await assert.rejects(plan(eu), /MEDIA binding's bucket eu-media is in the eu jurisdiction, which Set up media host can't use yet/);
		assert.deepEqual(domainsCalls(eu), [], "nothing was asked of the bucket");

		// Another media binding name (images.bucket in astro.config).
		const own = withZone(domains("coywolf-staging-backups"));
		await imagesModule({ media: "BACKUPS", variants: { start: async () => null, deps: async () => null } }).routes["images/setup/plan"].handler({ ...fakeCtx({ features: { images: true }, cloudflareApiToken: "tok" }, own.fetch), input: { host: "https://media.coywolf.com" } });
		assert.deepEqual(domainsCalls(own), ["coywolf-staging-backups"]);

		// The page shows what was found.
		const page = await routes["images/settings"].handler(fakeCtx({ features: { images: true }, cloudflareApiToken: "tok" }, cloudflare().fetch));
		assert.equal(page.detectedBucket.bucket, "coywolf-staging-media");
	} finally {
		globalThis.__testEnv = undefined;
	}
});

// ── Retention on Cloudflare ──────────────────────────────────

/** An R2 bucket in memory, as the backups module uses it. */
function memoryBucket() {
	const store = new Map();
	return {
		store,
		async put(key, body) {
			store.set(key, typeof body === "string" ? body : "stream");
			return { key };
		},
		async get(key) {
			return store.has(key) ? { body: store.get(key), json: async () => JSON.parse(store.get(key)), httpMetadata: {} } : null;
		},
		async delete(keys) {
			for (const k of [].concat(keys)) store.delete(k);
		},
		async list({ prefix = "" } = {}) {
			return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: key })), truncated: false, delimitedPrefixes: [] };
		},
	};
}

test("Retention on Cloudflare uses the bucket bound as BACKUPS, still checks it's the bound one, and a saved name wins", async () => {
	const { backupsModule, RETENTION_SETTINGS, RETENTION_STATE_KEY } = await import("../src/backups/module.ts");
	const { routes } = backupsModule({ name: "coywolf" });
	const backups = memoryBucket();
	globalThis.__testEnv = env({ DB: {}, MEDIA: memoryBucket(), BACKUPS: backups });
	/** Cloudflare's view: the bucket named `real` holds what the BACKUPS binding wrote; any other bucket is empty. */
	const cf = (real = "coywolf-staging-backups", options) => {
		const api = cloudflare({}, options);
		const inner = api.fetch;
		api.fetch = async (url, init = {}) => {
			const u = new URL(url);
			const m = /\/r2\/buckets\/([^/]+)\/(lifecycle|lock|objects)$/.exec(u.pathname);
			if (!m) return inner(url, init);
			api.calls.push({ key: `${init.method ?? "GET"} ${u.pathname}${u.search}`, path: `${u.pathname}${u.search}`, auth: init.headers?.Authorization });
			if (m[2] === "objects") {
				const prefix = u.searchParams.get("prefix");
				return ok(m[1] === real ? [...backups.store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) : []);
			}
			return ok(init.method === "PUT" ? {} : { rules: [] });
		};
		return api;
	};
	const bucketsTouched = (api) => [...new Set(api.calls.filter((c) => c.path.includes("/r2/buckets/")).map((c) => c.path.split("/r2/buckets/")[1].split("/")[0]))];
	try {
		const found = cf();
		const ctx = fakeCtx({ cloudflareApiToken: "tok" }, found.fetch);
		const state = await routes["backups/cloudflare/check"].handler({ ...ctx, input: {} });
		assert.equal(state.bucket, "coywolf-staging-backups");
		assert.deepEqual(bucketsTouched(found), ["coywolf-staging-backups"]);
		assert.deepEqual(ctx.kvMap.get(RETENTION_STATE_KEY), state);
		assert.equal(ctx.stored.get(RETENTION_SETTINGS.bucket), undefined, "a found bucket isn't saved as an override");

		// Applying uses it too.
		const applied = await routes["backups/cloudflare/apply"].handler({ ...ctx, input: { lock: false } });
		assert.equal(applied.bucket, "coywolf-staging-backups");

		// The bucket check still runs on a found name: a binding that names another bucket than the one BACKUPS writes to is refused.
		const elsewhere = cf("coywolf-staging-backups", { bindings: [{ type: "r2_bucket", name: "BACKUPS", bucket_name: "wellbeing-backups" }] });
		await assert.rejects(routes["backups/cloudflare/check"].handler({ ...fakeCtx({ cloudflareApiToken: "tok" }, elsewhere.fetch), input: {} }), /The bucket wellbeing-backups isn't the one bound as BACKUPS/);

		// A saved name wins: no lookup, and the check runs on it.
		const saved = cf("my-backups");
		const savedState = await routes["backups/cloudflare/check"].handler({ ...fakeCtx({ cloudflareApiToken: "tok", [RETENTION_SETTINGS.bucket]: "my-backups" }, saved.fetch), input: {} });
		assert.equal(savedState.bucket, "my-backups");
		assert.deepEqual(saved.workerCalls(), []);

		// Not found: the old message, with why. A jurisdiction: said plainly.
		const forbidden = cf("coywolf-staging-backups");
		const inner = forbidden.fetch;
		forbidden.fetch = async (url, init) => (new URL(url).pathname.endsWith("/workers/scripts") ? refused() : inner(url, init));
		await assert.rejects(routes["backups/cloudflare/check"].handler({ ...fakeCtx({ cloudflareApiToken: "tok" }, forbidden.fetch), input: {} }), /Enter the backup bucket name first\. The pack couldn't find it from the BACKUPS binding\. The Cloudflare API token can't read this site's Worker: it needs Workers → Metadata Read-Only\./);
		const eu = cf("coywolf-staging-backups", { bindings: [{ type: "r2_bucket", name: "BACKUPS", bucket_name: "eu-backups", jurisdiction: "eu" }] });
		await assert.rejects(routes["backups/cloudflare/check"].handler({ ...fakeCtx({ cloudflareApiToken: "tok" }, eu.fetch), input: {} }), /eu jurisdiction, which Retention on Cloudflare can't use yet/);
		assert.deepEqual(bucketsTouched(eu), [], "nothing was asked of the bucket");

		// The card shows what was found.
		const card = await routes["backups/cloudflare"].handler(fakeCtx({ cloudflareApiToken: "tok" }, cf().fetch));
		assert.deepEqual([card.detectedBucket.bucket, card.detectedBucket.binding, card.bucket], ["coywolf-staging-backups", "BACKUPS", ""]);
	} finally {
		globalThis.__testEnv = undefined;
	}
});

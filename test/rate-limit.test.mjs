// Run: node --test test/rate-limit.test.mjs
// Search, video plays and likes use the site's Workers Rate Limiting binding (COYWOLF_RATE_LIMITER by
// default) when it has one, counting across isolates; IPv6 visitors are counted by their /64.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = () => {};`, shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const { addressKey, rateLimitBinding, bindingAllows, DEFAULT_RATE_LIMITER } = await import("../src/core/rate-limit.ts");
const { rateLimitResponse, configureSearchRateLimit } = await import("../src/search/ratelimit.ts");

/** A Workers Rate Limiting binding that allows `limit` requests per key and records the keys. */
function binding(limit = Infinity) {
	const counts = new Map();
	return {
		keys: [],
		async limit({ key }) {
			this.keys.push(key);
			counts.set(key, (counts.get(key) ?? 0) + 1);
			return { success: counts.get(key) <= limit };
		},
	};
}

test("addresses: IPv4 as is, IPv6 by its /64, IPv4-mapped IPv6 as its IPv4 address", () => {
	assert.equal(addressKey("203.0.113.9"), "203.0.113.9");
	assert.equal(addressKey(" 203.0.113.9 "), "203.0.113.9");
	const a = addressKey("2001:db8:85a3:12:8a2e:370:7334:1");
	assert.equal(a, "2001:db8:85a3:12::/64");
	assert.equal(addressKey("2001:DB8:85A3:0012:ffff:ffff:ffff:ffff"), a, "any address in the same /64, any case or zero padding");
	assert.equal(addressKey("2001:db8:85a3:12::1"), a, "compressed");
	assert.notEqual(addressKey("2001:db8:85a3:13::1"), a, "the next /64 is someone else");
	assert.equal(addressKey("2001:db8::1"), "2001:db8:0:0::/64");
	assert.equal(addressKey("::1"), "0:0:0:0::/64");
	assert.equal(addressKey("fe80::1%eth0"), "fe80:0:0:0::/64", "zone id dropped");
	assert.equal(addressKey("::ffff:198.51.100.7"), "198.51.100.7");
	assert.equal(addressKey("64:ff9b::198.51.100.7"), "64:ff9b:0:0::/64");
	assert.equal(addressKey("not:an:address::x::y"), "not:an:address::x::y", "unparseable: kept as is");
});

test("the binding: found by its default name, consulted with each limit's own keys, never blocking when it fails", async () => {
	assert.equal(DEFAULT_RATE_LIMITER, "COYWOLF_RATE_LIMITER");
	const b = binding();
	assert.equal(rateLimitBinding({ COYWOLF_RATE_LIMITER: b }), b);
	assert.equal(rateLimitBinding({ OTHER: b }, "OTHER"), b);
	assert.equal(rateLimitBinding({}), undefined);
	assert.equal(rateLimitBinding({ COYWOLF_RATE_LIMITER: "not a binding" }), undefined);
	assert.equal(await bindingAllows(undefined, "k"), true, "no binding: the memory counter decides");
	assert.equal(await bindingAllows(binding(0), "k"), false);
	assert.equal(await bindingAllows({ limit: async () => { throw new Error("down"); } }, "k"), true);
});

function searchContext(ip) {
	const url = new URL("https://example.com/_emdash/api/plugins/coywolf-pack/search/live?q=x");
	return { url, request: new Request(url, { headers: { "cf-connecting-ip": ip } }), clientAddress: ip };
}

test("search: the COYWOLF_RATE_LIMITER binding decides when the site has one; one IPv6 /64 is one visitor", async () => {
	configureSearchRateLimit({});
	const b = binding(2);
	const env = { COYWOLF_RATE_LIMITER: b };
	assert.equal(await rateLimitResponse(searchContext("2001:db8:1:2::a"), env), undefined);
	assert.equal(await rateLimitResponse(searchContext("2001:db8:1:2::b"), env), undefined);
	const limited = await rateLimitResponse(searchContext("2001:db8:1:2:ffff::c"), env);
	assert.equal(limited?.status, 429, "a third address in the same /64 is over the binding's limit");
	assert.equal(new Set(b.keys).size, 1);
	assert.match(b.keys[0], /^search:[0-9a-f]{32}$/, "a salted hash, never the address");
	assert.equal(await rateLimitResponse(searchContext("2001:db8:1:3::a"), env), undefined, "another /64");
});

test("plays and likes: the binding limits them across isolates, on top of the per-isolate limits", async () => {
	const { invalidateFeatures } = await import("../src/core/features.ts");
	const { videosPack } = await import("../src/videos/pack.ts");
	const { routes } = videosPack({});
	const UID = "a67dcf0925d0747f8c5419df6400c2b5";
	const b = binding(0);
	globalThis.__testEnv = { COYWOLF_RATE_LIMITER: b };
	invalidateFeatures();
	const ctx = {
		input: { uid: UID, liked: true },
		request: new Request("https://example.com/", { method: "POST", headers: { "X-Coywolf-Video": "1" } }),
		requestMeta: { ip: "2001:db8:9:9::1" },
		settings: { get: async (key) => (key === "features" ? { videos: true, "videos.engagement": true } : null) },
		kv: { get: async () => null, set: async () => undefined, getVersioned: async () => null, compareAndSet: async () => ({ applied: true }), delete: async () => undefined },
		storage: {
			videosEmbeds: { query: async () => ({ items: [{ id: "posts:1", data: { status: "published", uids: [UID] } }], hasMore: false }), get: async () => null },
			videosStats: { get: async () => ({ plays: 7, likes: 3 }) },
			videosLikes: { exists: async () => false },
		},
		log: { info() {}, warn() {}, error() {} },
	};
	await assert.rejects(routes["videos/play"].handler(ctx), (error) => error.status === 429 || error.code === "RATE_LIMITED");
	await assert.rejects(routes["videos/like"].handler(ctx), (error) => error.status === 429 || error.code === "RATE_LIMITED");
	assert.ok(b.keys[0].startsWith("play:") && b.keys[1].startsWith("like:"), b.keys.join());
	delete globalThis.__testEnv;
	invalidateFeatures();
});

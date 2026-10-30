// Run: node --test test/images-setup.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { planMediaHostSetup, mediaHostRules, isOurRule, zoneCandidates, hostnameOf, sendableRule } = await import("../src/images/setup.ts");
const { checkItems, applySetup } = await import("../src/images/cloudflare.ts");

const HOST = "media.example.com";
const input = { host: `https://${HOST}`, zoneName: "example.com", bucket: "example-media" };
const unrelated = {
	id: "r1",
	version: "3",
	last_updated: "2026-01-01T00:00:00Z",
	ref: "keep",
	description: "Strip utm params",
	expression: 'http.request.uri.query contains "utm_"',
	action: "rewrite",
	action_parameters: { uri: { query: { value: "" } } },
	enabled: true,
};

test("the rules match what was set up by hand for wellbeing.io", () => {
	const [crop, width] = mediaHostRules(HOST);
	assert.equal(crop.description, "media.example.com: /s/<W>x<H>/<file> → cropped resize (Coywolf Pack clean image URLs)");
	assert.equal(crop.expression, '(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*x*/*")');
	assert.equal(
		crop.action_parameters.uri.path.expression,
		'wildcard_replace(http.request.uri.path, "/s/*x*/*", "/cdn-cgi/image/width=${1},height=${2},fit=cover,format=auto,quality=85/${3}")',
	);
	assert.equal(width.description, "media.example.com: /s/<W>/<file> → resize to width (Coywolf Pack clean image URLs)");
	assert.equal(width.expression, '(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*/*" and not http.request.uri.path wildcard "/s/*x*/*")');
	assert.equal(width.action_parameters.uri.path.expression, 'wildcard_replace(http.request.uri.path, "/s/*/*", "/cdn-cgi/image/width=${1},format=auto,quality=85/${2}")');
	assert.equal(crop.action, "rewrite");
});

test("a fresh zone needs all four steps", () => {
	const plan = planMediaHostSetup({ transformations: "off", domains: [], rules: null, tieredCache: "off" }, input);
	assert.deepEqual(plan.steps.map((s) => [s.id, s.action]), [["transformations", "enable"], ["domain", "add"], ["rules", "add"], ["tieredCache", "enable"]]);
	assert.equal(plan.done, false);
	assert.equal(plan.host, HOST);
	assert.deepEqual(plan.rules, mediaHostRules(HOST));
});

test("a finished setup needs nothing", () => {
	const rules = [unrelated, ...mediaHostRules(HOST).map((r, i) => ({ ...r, id: `x${i}`, version: "1" }))];
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: HOST, enabled: true }], rules, tieredCache: "on" }, input);
	assert.equal(plan.done, true);
	assert.deepEqual(plan.steps.map((s) => s.action), ["none", "none", "none", "none"]);
	assert.deepEqual(plan.rules, []);
});

test("keeps unrelated rules (without read-only fields) and appends ours", () => {
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: "MEDIA.example.com", enabled: false }], rules: [unrelated], tieredCache: "on" }, input);
	assert.deepEqual(plan.steps.map((s) => [s.id, s.action]), [["transformations", "none"], ["domain", "enable"], ["rules", "add"], ["tieredCache", "none"]]);
	assert.equal(plan.rules.length, 3);
	assert.deepEqual(plan.rules[0], sendableRule(unrelated));
	assert.equal(plan.rules[0].id, "r1");
	assert.equal(plan.rules[0].version, undefined);
	assert.equal(plan.rules[0].last_updated, undefined);
	assert.match(plan.steps[2].label, /1 other rule stay/);
});

test("replaces only our outdated rules, in place; other hosts' rules stay", () => {
	const old = { ...mediaHostRules(HOST)[0], id: "old", expression: '(http.host eq "media.example.com")' };
	const otherHost = { ...mediaHostRules("media.other.com")[0], id: "other" };
	const after = { ...unrelated, id: "r2", description: "Later rule" };
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: HOST }], rules: [unrelated, old, otherHost, after], tieredCache: "on" }, input);
	assert.deepEqual(plan.steps.map((s) => s.action), ["none", "none", "update", "none"]);
	assert.deepEqual(
		plan.rules.map((r) => r.id ?? r.description),
		["r1", mediaHostRules(HOST)[0].description, mediaHostRules(HOST)[1].description, "other", "r2"],
	);
	assert.ok(isOurRule(old, HOST));
	assert.ok(!isOurRule(otherHost, HOST));
	assert.ok(!isOurRule(unrelated, HOST));
});

test("a disabled rule of ours counts as outdated", () => {
	const rules = mediaHostRules(HOST).map((r, i) => ({ ...r, enabled: i === 0 ? false : true }));
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: HOST, enabled: true }], rules }, input);
	assert.equal(plan.steps[2].action, "update");
	assert.equal(plan.rules.length, 2);
});

test("zone candidates and host names", () => {
	assert.deepEqual(zoneCandidates("media.example.com"), ["example.com"]);
	assert.deepEqual(zoneCandidates("media.blog.example.co.uk"), ["blog.example.co.uk", "example.co.uk", "co.uk"]);
	assert.equal(hostnameOf("https://Media.Example.com/"), "media.example.com");
});

test("check results read plainly", () => {
	const good = checkItems({
		file: "ABC.webp",
		original: { status: 200, type: "image/webp" },
		resized: { status: 200, type: "image/avif", cfResized: "internal=ok/- q=0 n=10", cache: "HIT" },
	});
	assert.deepEqual(good.map((i) => [i.id, i.ok]), [["reachable", true], ["original", true], ["resize", true], ["cached", true]]);
	const noRules = checkItems({ file: "ABC.webp", original: { status: 200, type: "image/webp" }, resized: { status: 404, type: "text/html", cfResized: null, cache: null } });
	assert.deepEqual(noRules.map((i) => i.ok), [true, true, false, false]);
	assert.match(noRules[2].detail, /rewrite rules/);
	const down = checkItems({ file: "ABC.webp", original: { error: "DNS lookup failed" }, resized: { error: "DNS lookup failed" } });
	assert.deepEqual(down.map((i) => i.ok), [false, false, false, false]);
});

test("Smart Tiered Cache: off or unreadable needs the step, on doesn't", () => {
	const rules = mediaHostRules(HOST).map((r, i) => ({ ...r, id: `x${i}`, version: "1" }));
	const base = { transformations: "on", domains: [{ domain: HOST, enabled: true }], rules };
	for (const tieredCache of ["off", null, undefined]) {
		const plan = planMediaHostSetup({ ...base, tieredCache }, input);
		const step = plan.steps.find((s) => s.id === "tieredCache");
		assert.equal(step.action, "enable", `tieredCache=${tieredCache}`);
		assert.match(step.label, /Smart Tiered Cache for example\.com/);
		assert.equal(plan.done, false);
	}
	const on = planMediaHostSetup({ ...base, tieredCache: "on" }, input);
	assert.equal(on.steps.find((s) => s.id === "tieredCache").action, "none");
	assert.equal(on.done, true);
});

/** A fake Cloudflare API for applySetup: records calls; `deny` makes a path answer 403. */
function fakeCloudflare({ tiered = "off", deny = [] } = {}) {
	const calls = [];
	const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
	const fetch = async (url, init = {}) => {
		const path = new URL(url).pathname.replace("/client/v4", "");
		const method = init.method ?? "GET";
		calls.push(`${method} ${path}`);
		if (deny.some((d) => path.endsWith(d))) return new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 });
		if (path === "/zones") return ok([{ id: "z1", name: "example.com" }]);
		if (path.endsWith("/settings/transformations")) return ok({ value: "on" });
		if (path.endsWith("/domains/custom")) return ok({ domains: [{ domain: HOST, enabled: true }] });
		if (path.endsWith("/http_request_transform/entrypoint")) return ok({ rules: mediaHostRules(HOST).map((r, i) => ({ ...r, id: `x${i}`, version: "1" })) });
		if (path.endsWith("/cache/tiered_cache_smart_topology_enable")) return ok({ value: method === "PATCH" ? "on" : tiered });
		return ok({});
	};
	return { calls, config: { token: "t", accountId: "a", fetch } };
}

test("applySetup turns Smart Tiered Cache on, and only when it's off", async () => {
	const off = fakeCloudflare({ tiered: "off" });
	const r = await applySetup(off.config, { host: HOST, bucket: "example-media" });
	assert.ok(off.calls.includes("PATCH /zones/z1/cache/tiered_cache_smart_topology_enable"));
	assert.deepEqual(r.results.find((x) => x.id === "tieredCache"), { id: "tieredCache", ok: true, message: "Turned on Smart Tiered Cache for example.com." });

	const on = fakeCloudflare({ tiered: "on" });
	await applySetup(on.config, { host: HOST, bucket: "example-media" });
	assert.ok(!on.calls.some((c) => c.startsWith("PATCH") && c.includes("tiered_cache")), "never PATCHed when already on");
});

test("a token without Zone Settings Edit: the rest of the setup still runs, the step explains the permission", async () => {
	const fake = fakeCloudflare({ deny: ["/cache/tiered_cache_smart_topology_enable"] });
	const r = await applySetup(fake.config, { host: HOST, bucket: "example-media" });
	const step = r.results.find((x) => x.id === "tieredCache");
	assert.equal(step.ok, false);
	assert.match(step.message, /Zone → Zone Settings → Edit/);
	assert.ok(r.results.filter((x) => x.id !== "tieredCache").every((x) => x.ok));
});

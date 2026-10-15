import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { extractLinks, extractEntryLinks, transformLinks, transformEntry, isInternal, resolveHref, isTrackable } = await import("../src/links/pt.ts");
const { classify, isBotWall, nextCheckAt, normalizeIgnore, ruleMatches, isIgnored, isPublicTarget, IgnoreRuleError } = await import("../src/links/classify.ts");
const { checkUrl, BudgetExhausted } = await import("../src/links/check.ts");
const store = await import("../src/links/store.ts");
const { isAllowedTarget } = await import("../src/links/pt.ts");

const deepFreeze = (v) => {
	if (v && typeof v === "object") {
		Object.freeze(v);
		for (const child of Object.values(v)) deepFreeze(child);
	}
	return v;
};

const doc = () =>
	deepFreeze([
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [
				{ _type: "link", _key: "l1", href: "https://example.com/a", blank: true },
				{ _type: "link", _key: "l2", href: "/about/" },
				{ _type: "comment", _key: "c1", text: "not a link" },
			],
			children: [
				{ _type: "span", _key: "s1", text: "Read ", marks: [] },
				{ _type: "span", _key: "s2", text: "this", marks: ["strong", "l1"] },
				{ _type: "span", _key: "s3", text: " article", marks: ["l1"] },
				{ _type: "span", _key: "s4", text: " and ", marks: [] },
				{ _type: "span", _key: "s5", text: "about us", marks: ["l2", "em", "c1"] },
			],
		},
		{ _type: "image", _key: "i1", asset: { _ref: "m1", url: "/_emdash/api/media/file/x.jpg" }, link: { href: "https://example.com/a", blank: false }, alt: "x" },
		{ _type: "image", _key: "i2", asset: { _ref: "m2", url: "/media/y.jpg" }, link: "https://legacy.example.org/" },
		{ _type: "buttons", _key: "bt", buttons: [{ _type: "button", _key: "b", text: "Buy", url: "https://shop.example.net/p" }] },
		{ _type: "embed", _key: "e1", url: "https://www.youtube.com/watch?v=abc" },
		{ _type: "iframe", _key: "f1", src: "https://maps.example.com/embed" },
		{
			_type: "columns",
			_key: "col",
			columns: [
				{
					_type: "column",
					_key: "c",
					content: [
						{
							_type: "block",
							_key: "nb",
							markDefs: [{ _type: "link", _key: "n1", href: "https://example.com/a" }],
							children: [{ _type: "span", _key: "ns", text: "nested", marks: ["n1"] }],
						},
					],
				},
			],
		},
		{
			_type: "table",
			_key: "t",
			rows: [
				{
					_type: "tableRow",
					_key: "r",
					cells: [
						{
							_type: "tableCell",
							_key: "tc",
							markDefs: [{ _type: "link", _key: "tl", href: "mailto:hi@example.com" }],
							content: [{ _type: "span", _key: "ts", text: "mail", marks: ["tl"] }],
						},
					],
				},
			],
		},
	]);

// ── Extraction ───────────────────────────────────────────────────

test("extracts link marks with anchor text, linked images, buttons, embeds and nested blocks", () => {
	const links = extractLinks(doc());
	const summary = links.map((l) => `${l.kind}:${l.href}:${l.anchor}`);
	assert.deepEqual(summary, [
		"text:https://example.com/a:this article",
		"text:/about/:about us",
		"image:https://example.com/a:",
		"image:https://legacy.example.org/:",
		"button:https://shop.example.net/p:",
		"embed:https://www.youtube.com/watch?v=abc:",
		"iframe:https://maps.example.com/embed:",
		"text:https://example.com/a:nested",
	]);
});

test("skips mailto, tel, javascript, fragments and media asset URLs", () => {
	assert.equal(isTrackable("mailto:a@b.c"), false);
	assert.equal(isTrackable("tel:123"), false);
	assert.equal(isTrackable("javascript:alert(1)"), false);
	assert.equal(isTrackable("#top"), false);
	assert.equal(isTrackable("ftp://x"), false);
	assert.equal(isTrackable("//cdn.example.com/x"), true);
	assert.ok(!extractLinks(doc()).some((l) => l.href.includes("/media/")));
});

test("extracts from URL fields and only listed fields", () => {
	const data = { body: doc(), website: "https://site.example/", other: [{ _type: "embed", url: "https://ignored.example/" }] };
	const links = extractEntryLinks(data, [
		{ slug: "body", type: "portableText" },
		{ slug: "website", type: "url" },
	]);
	assert.ok(links.some((l) => l.kind === "field" && l.href === "https://site.example/"));
	assert.ok(!links.some((l) => l.href.includes("ignored")));
});

test("internal vs external", () => {
	assert.equal(isInternal("/about/", "https://wellbeing.io"), true);
	assert.equal(isInternal("https://www.wellbeing.io/x", "https://wellbeing.io"), true);
	assert.equal(isInternal("https://example.com/", "https://wellbeing.io"), false);
	assert.equal(resolveHref("/a#frag", "https://wellbeing.io")?.href, "https://wellbeing.io/a");
});

// ── Transforms ───────────────────────────────────────────────────

test("replace rewrites every matching href without mutating the input and keeps other marks", () => {
	const input = doc();
	const before = JSON.stringify(input);
	const { value, changed } = transformLinks(input, (h) => h === "https://example.com/a", { type: "replace", to: "https://example.com/b" });
	assert.equal(JSON.stringify(input), before, "input unchanged");
	assert.equal(changed, 3);
	assert.deepEqual(value[0].markDefs[0], { _type: "link", _key: "l1", href: "https://example.com/b", blank: true });
	assert.deepEqual(value[0].children[1].marks, ["strong", "l1"]);
	assert.deepEqual(value[1].link, { href: "https://example.com/b", blank: false });
	assert.equal(value[6].columns[0].content[0].markDefs[0].href, "https://example.com/b");
	// Untouched subtrees are shared, not copied.
	assert.equal(value[2], input[2]);
	assert.equal(value[7], input[7]);
	assert.equal(extractLinks(value).filter((l) => l.href === "https://example.com/a").length, 0);
});

test("unlink removes the mark def and its key from spans, keeping text and other marks", () => {
	const input = doc();
	const { value, changed, skipped } = transformLinks(input, (h) => h === "/about/", { type: "unlink" });
	assert.equal(changed, 1);
	assert.equal(skipped, 0);
	assert.deepEqual(
		value[0].markDefs.map((d) => d._key),
		["l1", "c1"],
	);
	assert.deepEqual(value[0].children[4], { _type: "span", _key: "s5", text: "about us", marks: ["em", "c1"] });
	assert.equal(value[0].children[1], input[0].children[1], "other spans shared");
	assert.equal(input[0].markDefs.length, 3, "input unchanged");
});

test("unlink drops image links and button URLs but leaves embeds and iframes", () => {
	const input = doc();
	const a = transformLinks(input, (h) => h === "https://example.com/a", { type: "unlink" });
	assert.equal(a.changed, 3);
	assert.equal("link" in a.value[1], false);
	assert.equal(a.value[1].alt, "x");
	assert.equal(a.value[6].columns[0].content[0].children[0].marks.length, 0);
	const b = transformLinks(input, (h) => h === "https://shop.example.net/p", { type: "unlink" });
	assert.equal("url" in b.value[3].buttons[0], false);
	assert.equal(b.value[3].buttons[0].text, "Buy");
	const c = transformLinks(input, (h) => h === "https://maps.example.com/embed", { type: "unlink" });
	assert.equal(c.changed, 0);
	assert.equal(c.skipped, 1);
	assert.equal(c.value, input, "nothing changed, same reference");
});

test("transformEntry returns only changed fields", () => {
	const data = deepFreeze({ body: doc(), website: "https://example.com/a", title: "T" });
	const fields = [
		{ slug: "body", type: "portableText" },
		{ slug: "website", type: "url" },
	];
	const r = transformEntry(data, fields, (h) => h === "https://example.com/a", { type: "replace", to: "/new/" });
	assert.deepEqual(Object.keys(r.patch).sort(), ["body", "website"]);
	assert.equal(r.patch.website, "/new/");
	assert.equal(r.changed, 4);
	const u = transformEntry(data, fields, (h) => h === "https://example.com/a", { type: "unlink" });
	assert.equal(u.skipped, 1, "URL fields can't be unlinked");
	assert.equal("website" in u.patch, false);
});

// ── Classification ───────────────────────────────────────────────

test("status classes", () => {
	assert.equal(classify([{ url: "https://a.test/", code: 200 }], false).status, "ok");
	assert.equal(classify([{ url: "https://a.test/x", code: 404 }], false).status, "broken");
	assert.equal(classify([{ url: "https://a.test/x", code: 500 }], false).status, "broken");
	assert.equal(classify([], false, "Timed out after 10 seconds").status, "error");
	const r = classify(
		[
			{ url: "http://a.test/x", code: 301 },
			{ url: "https://a.test/y", code: 200 },
		],
		false,
	);
	assert.equal(r.status, "redirect");
	assert.equal(r.finalUrl, "https://a.test/y");
	// A trailing-slash-only redirect isn't worth reporting.
	assert.equal(
		classify(
			[
				{ url: "https://a.test/x", code: 301 },
				{ url: "https://a.test/x/", code: 200 },
			],
			false,
		).status,
		"ok",
	);
	const broken = classify(
		[
			{ url: "https://a.test/x", code: 302 },
			{ url: "https://a.test/gone", code: 410 },
		],
		false,
	);
	assert.equal(broken.status, "broken");
	assert.match(broken.note, /302.*410/);
});

test("bot walls are Blocked, not Broken", () => {
	for (const code of [403, 429, 999]) {
		assert.equal(isBotWall(code, new Headers()), true);
		assert.equal(classify([{ url: "https://linkedin.test/", code }], true).status, "blocked");
	}
	assert.equal(isBotWall(503, new Headers({ "cf-mitigated": "challenge" })), true);
	assert.equal(isBotWall(202, new Headers({ "x-amzn-waf-action": "challenge" })), true);
	assert.equal(isBotWall(404, new Headers()), false);
	assert.equal(isBotWall(503, new Headers({ server: "cloudflare" })), false);
});

test("recheck schedule: problems daily, the rest weekly", () => {
	const now = Date.UTC(2026, 0, 1);
	const day = 86_400_000;
	assert.equal(nextCheckAt("broken", now), new Date(now + day).toISOString());
	assert.equal(nextCheckAt("error", now), new Date(now + day).toISOString());
	assert.equal(nextCheckAt("ok", now), new Date(now + 7 * day).toISOString());
	assert.equal(nextCheckAt("blocked", now), new Date(now + 7 * day).toISOString());
});

test("ignore rules", () => {
	const rule = (type, value) => ({ id: "x", type, value: normalizeIgnore(type, value) });
	assert.equal(normalizeIgnore("domain", "https://www.LinkedIn.com/in/x"), "linkedin.com");
	assert.equal(ruleMatches(rule("domain", "linkedin.com"), "https://uk.linkedin.com/in/x"), true);
	assert.equal(ruleMatches(rule("domain", "linkedin.com"), "https://notlinkedin.com/"), false);
	assert.equal(ruleMatches(rule("url", "https://Example.com/a/"), "https://example.com/a"), true);
	assert.equal(ruleMatches(rule("wildcard", "https://example.com/visit/*"), "https://example.com/visit/partner?x=1"), true);
	assert.equal(ruleMatches(rule("wildcard", "https://example.com/visit/*"), "https://example.com/other"), false);
	assert.equal(ruleMatches(rule("regex", "^https://amzn\\.to/"), "https://amzn.to/abc"), true);
	assert.throws(() => normalizeIgnore("regex", "("), IgnoreRuleError);
	assert.throws(() => normalizeIgnore("domain", "not a domain"), IgnoreRuleError);
	assert.equal(isIgnored([rule("domain", "a.test"), rule("url", "https://b.test/x")], "https://b.test/x/"), true);
	assert.equal(isIgnored([], "https://b.test/x/"), false);
});

test("private and local targets are refused", () => {
	for (const u of ["http://localhost/", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://printer.local/"]) {
		assert.equal(isPublicTarget(new URL(u)), false, u);
	}
	assert.equal(isPublicTarget(new URL("https://example.com/")), true);
	assert.equal(isPublicTarget(new URL("http://8.8.8.8/")), true);
});

// ── Checker (fetch stubbed) ──────────────────────────────────────

const stub = (routes) => {
	const calls = [];
	const fetcher = async (url, init) => {
		calls.push(`${init.method} ${url}`);
		const r = routes[`${init.method} ${url}`] ?? routes[url];
		if (!r) throw new Error("getaddrinfo ENOTFOUND");
		if (r === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
		// A plain Response-like object: real fetch can surface statuses (999) the Response constructor rejects.
		return { status: r.status, headers: new Headers(r.headers ?? {}), body: null };
	};
	return { fetcher, calls };
};

test("checker: HEAD ok, redirect chain recorded, GET fallback, budget", async () => {
	let s = stub({ "https://a.test/": { status: 200 } });
	assert.equal((await checkUrl(new URL("https://a.test/"), { left: 10 }, { fetcher: s.fetcher })).status, "ok");
	assert.deepEqual(s.calls, ["HEAD https://a.test/"]);

	s = stub({
		"https://a.test/old": { status: 301, headers: { location: "/new" } },
		"https://a.test/new": { status: 200 },
	});
	const r = await checkUrl(new URL("https://a.test/old"), { left: 10 }, { fetcher: s.fetcher });
	assert.equal(r.status, "redirect");
	assert.deepEqual(
		r.chain.map((h) => h.code),
		[301, 200],
	);

	s = stub({ "HEAD https://a.test/x": { status: 405 }, "GET https://a.test/x": { status: 200 } });
	assert.equal((await checkUrl(new URL("https://a.test/x"), { left: 10 }, { fetcher: s.fetcher })).status, "ok");
	assert.deepEqual(s.calls, ["HEAD https://a.test/x", "GET https://a.test/x"]);

	s = stub({ "https://a.test/gone": { status: 404 } });
	assert.equal((await checkUrl(new URL("https://a.test/gone"), { left: 10 }, { fetcher: s.fetcher })).status, "broken");

	s = stub({ "https://linkedin.test/": { status: 999 } });
	assert.equal((await checkUrl(new URL("https://linkedin.test/"), { left: 10 }, { fetcher: s.fetcher })).status, "blocked");

	s = stub({});
	const dns = await checkUrl(new URL("https://nope.test/"), { left: 10 }, { fetcher: s.fetcher });
	assert.equal(dns.status, "error");
	assert.match(dns.note, /DNS/);

	s = stub({ "https://slow.test/": "timeout" });
	assert.match((await checkUrl(new URL("https://slow.test/"), { left: 10 }, { fetcher: s.fetcher })).note, /Timed out/);

	s = stub({ "https://a.test/r": { status: 302, headers: { location: "http://127.0.0.1/admin" } } });
	assert.equal((await checkUrl(new URL("https://a.test/r"), { left: 10 }, { fetcher: s.fetcher })).status, "error");

	s = stub({ "HEAD https://a.test/x": { status: 405 } });
	await assert.rejects(checkUrl(new URL("https://a.test/x"), { left: 1 }, { fetcher: s.fetcher }), BudgetExhausted);
});

// ── Unlink shapes, targets, guards ───────────────────────────────

test("unlink only touches known link shapes; other href/link fields are skipped", () => {
	const input = deepFreeze([
		{ _type: "card", _key: "c", href: "https://x.test/", link: "https://x.test/" },
		{ _type: "image", _key: "i", asset: { _ref: "m" }, link: "https://x.test/" },
	]);
	const r = transformLinks(input, (h) => h === "https://x.test/", { type: "unlink" });
	assert.equal(r.changed, 1);
	assert.equal(r.skipped, 2);
	assert.equal(r.value[0], input[0]);
	assert.equal("link" in r.value[1], false);
});

test("replacement targets refuse protocol-relative forms", () => {
	for (const ok of ["https://a.test/x", "/path/", "#top", "mailto:a@b.test", "tel:+1"]) assert.equal(isAllowedTarget(ok), true, ok);
	for (const bad of ["//evil.test/", "/\\evil.test/", "https:///evil.test", "https://a.test\\@evil.test/", "javascript:alert(1)", "ftp://x", "", "/a\nb"]) {
		assert.equal(isAllowedTarget(bad), false, bad);
	}
});

test("address guard covers trailing-dot localhost, NAT64 and benchmark ranges", () => {
	for (const u of ["http://localhost./", "http://198.18.0.1/", "http://198.19.255.1/", "http://[64:ff9b::7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/"]) {
		assert.equal(isPublicTarget(new URL(u)), false, u);
	}
	assert.equal(isPublicTarget(new URL("http://198.20.0.1/")), true);
});

test("address guard covers IPv6 private forms, encoded IPv4 and local names", () => {
	const refused = [
		// IPv4 written as one number, in octal or hex, or shortened (the URL parser turns these into dotted form).
		"http://2130706433/",
		"http://017700000001/",
		"http://0x7f000001/",
		"http://0x7f.0.0.1/",
		"http://127.1/",
		"http://0177.0.0.1/",
		"http://3232235521/",
		"http://192.0.0.8/",
		// IPv6 loopback, unspecified, IPv4-compatible/mapped/translated, private, link/site-local, multicast, 6to4, Teredo.
		"http://[0:0:0:0:0:0:0:1]/",
		"http://[::]/",
		"http://[::127.0.0.1]/",
		"http://[::ffff:10.0.0.1]/",
		"http://[::ffff:7f00:1]/",
		"http://[::ffff:0:7f00:1]/",
		"http://[fd12:3456::1]/",
		"http://[fc00::1]/",
		"http://[fe80::1]/",
		"http://[febf::1]/",
		"http://[fec0::1]/",
		"http://[ff02::1]/",
		"http://[64:ff9b:1::a00:1]/",
		"http://[100::1]/",
		"http://[2002:7f00:1::]/",
		"http://[2001:0:4136:e378::1]/",
		"http://[2001:db8::1]/",
		// Local names.
		"http://ip6-localhost/",
		"http://app.localdomain/",
		"http://nas.home.arpa/",
		"http://router.lan/",
		"http://metadata.google.internal/",
		"http://metadata/",
		"http://LOCALHOST/",
		"http://sub.localhost./",
	];
	for (const u of refused) assert.equal(isPublicTarget(new URL(u)), false, u);
	for (const u of ["http://[2606:4700:4700::1111]/", "https://[2a00:1450:4001:80b::200e]/", "http://1.1.1.1/", "https://0xford.example/", "https://123.example/"]) {
		assert.equal(isPublicTarget(new URL(u)), true, u);
	}
});

test("regex ignore rules refuse catastrophic patterns", () => {
	for (const bad of ["(a+)+$", "(a|ab)*c", "(x*){2,}", "(a)\\1", "a".repeat(201)]) assert.throws(() => normalizeIgnore("regex", bad), IgnoreRuleError, bad);
	assert.equal(normalizeIgnore("regex", "^https://example\\.com/(tag|category)/"), "^https://example\\.com/(tag|category)/");
});

// ── Storage (in-memory fake with D1's 100-parameter limit) ───────

const MAX_PARAMS = 100;
function fakeCollection() {
	const rows = new Map();
	const params = (where = {}) =>
		2 + Object.values(where).reduce((n, v) => n + (v && typeof v === "object" && "in" in v ? v.in.length : 1), 0);
	const matches = (data, where = {}) =>
		Object.entries(where).every(([k, cond]) => {
			const v = data[k] ?? null;
			if (cond && typeof cond === "object") {
				if ("in" in cond) return cond.in.includes(v);
				if ("startsWith" in cond) return typeof v === "string" && v.startsWith(cond.startsWith);
				if (v === null) return false;
				return (cond.lt === undefined || v < cond.lt) && (cond.lte === undefined || v <= cond.lte) && (cond.gt === undefined || v > cond.gt) && (cond.gte === undefined || v >= cond.gte);
			}
			return v === cond;
		});
	const check = (n) => {
		if (n > MAX_PARAMS) throw new Error(`too many SQL variables (${n})`);
	};
	return {
		rows,
		async get(id) {
			return rows.get(id) ?? null;
		},
		async put(id, data) {
			rows.set(id, structuredClone(data));
		},
		async getMany(ids) {
			check(ids.length + 2);
			return new Map(ids.filter((id) => rows.has(id)).map((id) => [id, structuredClone(rows.get(id))]));
		},
		async putMany(items) {
			for (const { id, data } of items) rows.set(id, structuredClone(data));
		},
		async deleteMany(ids) {
			check(ids.length + 2);
			let n = 0;
			for (const id of ids) if (rows.delete(id)) n++;
			return n;
		},
		async delete(id) {
			return rows.delete(id);
		},
		async count(where) {
			check(params(where));
			return [...rows.values()].filter((d) => matches(d, where)).length;
		},
		async query({ where, orderBy, limit = 50, cursor } = {}) {
			check(params(where));
			let all = [...rows].filter(([, d]) => matches(d, where)).map(([id, data]) => ({ id, data: structuredClone(data) }));
			const [field, dir] = Object.entries(orderBy ?? {})[0] ?? [];
			if (field) all.sort((a, b) => ((a.data[field] ?? "") < (b.data[field] ?? "") ? -1 : (a.data[field] ?? "") > (b.data[field] ?? "") ? 1 : 0) * (dir === "desc" ? -1 : 1));
			const start = cursor ? Number(cursor) : 0;
			const items = all.slice(start, start + Math.min(limit, 100));
			const hasMore = start + items.length < all.length;
			return { items, hasMore, cursor: hasMore ? String(start + items.length) : undefined };
		},
	};
}

function fakeKv() {
	const map = new Map();
	let rev = 0;
	return {
		async get(k) {
			return map.has(k) ? structuredClone(map.get(k).value) : null;
		},
		async set(k, value) {
			map.set(k, { value: structuredClone(value), revision: String(++rev) });
		},
		async delete(k) {
			return map.delete(k);
		},
		async getVersioned(k) {
			return map.has(k) ? structuredClone(map.get(k)) : null;
		},
		async compareAndSet(k, expected, value) {
			const cur = map.get(k);
			if ((cur?.revision ?? null) !== expected) return { applied: false };
			const revision = String(++rev);
			map.set(k, { value: structuredClone(value), revision });
			return { applied: true, revision };
		},
		async compareAndDelete(k, expected) {
			if (map.get(k)?.revision !== expected) return { applied: false };
			map.delete(k);
			return { applied: true };
		},
	};
}

const block = (key, href, text = "link") => ({
	_type: "block",
	_key: key,
	markDefs: [{ _type: "link", _key: `m${key}`, href }],
	children: [{ _type: "span", _key: `s${key}`, text, marks: [`m${key}`] }],
});

function fakeCtx({ siteUrl = "https://site.test", entries = [] } = {}) {
	const logs = [];
	return {
		logs,
		storage: { links_urls: fakeCollection(), links_refs: fakeCollection() },
		kv: fakeKv(),
		site: { url: siteUrl },
		log: { info: () => {}, debug: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
		schema: {
			async listCollections() {
				return [
					{
						slug: "posts",
						label: "Posts",
						titleField: "title",
						supports: [],
						fields: [
							{ slug: "title", type: "string" },
							{ slug: "body", type: "portableText" },
						],
					},
				];
			},
		},
		content: {
			// Like EmDash: trashed entries are neither listed nor found.
			async list(_collection, { limit, cursor }) {
				const live = entries.filter((e) => !e.trashed);
				const start = cursor ? Number(cursor) : 0;
				const items = live.slice(start, start + limit);
				const hasMore = start + limit < live.length;
				return { items, hasMore, cursor: hasMore ? String(start + limit) : undefined };
			},
			async get(_collection, id) {
				return entries.find((e) => e.id === id && !e.trashed) ?? null;
			},
		},
	};
}

const ids500 = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(24, "0"));

test("id lists are chunked under D1's 100-parameter limit", async () => {
	const col = fakeCollection();
	for (const id of ids500) await col.put(id, { urlId: id, n: 1 });
	await assert.rejects(col.getMany(ids500), /too many SQL variables/, "the stub enforces the limit");
	const ops = new store.Ops();
	assert.equal((await store.getMany(col, ids500, ops)).size, 500);
	assert.equal(ops.used, 6);
	assert.equal((await store.queryIn(col, "urlId", ids500)).length, 500);
	assert.equal(await store.deleteMany(col, ids500), 500);
	assert.equal(col.rows.size, 0);
});

test("indexing: refs per entry, orphans dropped, counts derived from refs", async () => {
	const ctx = fakeCtx();
	const urls = ctx.storage.links_urls;
	const refs = ctx.storage.links_refs;
	const a = { id: "a", slug: "a", status: "published", data: { title: "A", body: [block("1", "https://x.test/"), block("2", "/about/")] } };
	const b = { id: "b", slug: "b", status: "draft", data: { title: "B", body: [block("1", "https://x.test/")] } };
	assert.equal(await store.indexEntry(ctx, "posts", a), 2);
	assert.equal(await store.indexEntry(ctx, "posts", b), 1);
	assert.equal(await store.indexEntry(ctx, "posts", b), 1, "re-indexing is idempotent");
	assert.equal(urls.rows.size, 2);
	assert.equal(refs.rows.size, 3);
	const about = [...urls.rows.values()].find((r) => r.url === "/about/");
	assert.equal(about.internal, true);
	assert.equal(about.resolved, "https://site.test/about/");
	// A drops /about/: its row goes; x.test stays (B still uses it).
	await store.indexEntry(ctx, "posts", { ...a, data: { title: "A", body: [block("1", "https://x.test/")] } });
	assert.equal(urls.rows.size, 1);
	await store.removeEntry(ctx, "posts", "a");
	assert.equal(urls.rows.size, 1);
	await store.removeEntry(ctx, "posts", "b");
	assert.equal(urls.rows.size, 0);
	assert.equal(refs.rows.size, 0);
});

test("indexing bails without a site URL instead of misclassifying internal links", async () => {
	const ctx = fakeCtx({ siteUrl: "" });
	const r = await store.indexEntry(ctx, "posts", { id: "a", status: "published", data: { body: [block("1", "/about/")] } });
	assert.equal(r, -1);
	assert.equal(ctx.storage.links_urls.rows.size, 0);
	assert.ok(ctx.logs.some((m) => /site URL/.test(m)));
});

test("an entry with hundreds of links indexes and removes without exceeding parameter limits", async () => {
	const ctx = fakeCtx();
	const body = Array.from({ length: 300 }, (_, i) => block(String(i), `https://x.test/${i}`));
	assert.equal(await store.indexEntry(ctx, "posts", { id: "big", status: "published", data: { body } }), 300);
	await store.removeEntry(ctx, "posts", "big");
	assert.equal(ctx.storage.links_urls.rows.size, 0);
});

test("scan: bounded steps resume mid-page, stale refs are dropped, one scan at a time", async () => {
	const entries = Array.from({ length: 23 }, (_, i) => ({ id: `e${i}`, slug: `e${i}`, status: "published", data: { title: `E${i}`, body: [block("1", `https://x.test/${i % 5}`)] } }));
	const ctx = fakeCtx({ entries });
	// A stale reference from an entry that no longer exists.
	await store.indexEntry(ctx, "posts", { id: "gone", status: "published", data: { body: [block("1", "https://gone.test/")] } });
	await new Promise((r) => setTimeout(r, 5));
	await store.startScan(ctx);

	// Two overlapping steps: only one runs.
	const [s1, s2] = await Promise.all([store.scanStep(ctx, new store.Ops(60)), store.scanStep(ctx, new store.Ops(60))]);
	assert.equal([s1, s2].filter((s) => s.busy).length, 1);

	let state = (await store.getScan(ctx)) ?? {};
	for (let i = 0; i < 50 && state.status === "running"; i++) state = await store.scanStep(ctx, new store.Ops(60));
	assert.equal(state.status, "idle");
	assert.equal(state.processed, 23);
	assert.equal(ctx.storage.links_refs.rows.size, 23);
	assert.equal(ctx.storage.links_urls.rows.size, 5, "gone.test dropped");
	assert.ok(![...ctx.storage.links_urls.rows.values()].some((r) => r.url.includes("gone")));
});

/** Run a scan to the end; returns the ids of links_refs rows written (put) along the way. */
async function fullScan(ctx) {
	const written = [];
	const refs = ctx.storage.links_refs;
	const putMany = refs.putMany;
	refs.putMany = async (items) => {
		written.push(...items.map((i) => i.id));
		return putMany.call(refs, items);
	};
	try {
		await store.startScan(ctx);
		let state = await store.getScan(ctx);
		for (let i = 0; i < 50 && state.status === "running"; i++) state = await store.scanStep(ctx, new store.Ops(60));
		assert.equal(state.status, "idle");
		return written.sort();
	} finally {
		refs.putMany = putMany;
	}
}

test("scan: unchanged entries write no references; only new or changed rows are written", async () => {
	const entry = (i, extra = {}) => ({ id: `e${i}`, slug: `e${i}`, status: "published", data: { title: `E${i}`, body: [block("1", `https://x.test/${i}`), block("2", "https://shared.test/")] }, ...extra });
	const entries = Array.from({ length: 6 }, (_, i) => entry(i));
	const ctx = fakeCtx({ entries });
	assert.equal((await fullScan(ctx)).length, 12, "the first scan writes every reference");
	assert.deepEqual(await fullScan(ctx), [], "an unchanged rescan writes nothing");
	const before = new Map(ctx.storage.links_refs.rows);

	const id = async (e, href) => `posts/${e}|${await store.urlId(href)}`;
	entries[0] = entry(0, { data: { title: "E0", body: [block("1", "https://x.test/0", "new anchor"), block("2", "https://shared.test/")] } });
	entries[1] = entry(1, { data: { ...entries[1].data, title: "Renamed" } });
	entries[2] = entry(2, { status: "draft" });
	entries[3] = entry(3, { data: { title: "E3", body: [block("1", "https://x.test/3"), { _type: "image", _key: "i", asset: { _ref: "m" }, link: "https://shared.test/" }] } });
	entries[4] = entry(4, { data: { title: "E4", body: [block("1", "https://x.test/4"), block("2", "https://shared.test/"), block("3", "https://new.test/")] } });
	entries[5] = entry(5, { data: { title: "E5", body: [block("2", "https://shared.test/")] } });
	const written = await fullScan(ctx);
	assert.deepEqual(
		written,
		[
			await id("e0", "https://x.test/0"), // anchor
			await id("e1", "https://x.test/1"), // title
			await id("e1", "https://shared.test/"),
			await id("e2", "https://x.test/2"), // status
			await id("e2", "https://shared.test/"),
			await id("e3", "https://shared.test/"), // kinds
			await id("e4", "https://new.test/"), // added
		].sort(),
	);
	const refs = ctx.storage.links_refs.rows;
	assert.equal(refs.get(await id("e1", "https://x.test/1")).title, "Renamed");
	assert.equal(refs.get(await id("e2", "https://x.test/2")).entryStatus, "draft");
	assert.deepEqual(refs.get(await id("e3", "https://shared.test/")).kinds, ["image"]);
	assert.deepEqual(refs.get(await id("e0", "https://x.test/0")).anchors, ["new anchor"]);
	assert.equal(refs.has(await id("e5", "https://x.test/5")), false, "a link removed from an entry is deleted");
	assert.ok(![...ctx.storage.links_urls.rows.values()].some((r) => r.url === "https://x.test/5"), "and its orphaned URL row");
	assert.ok([...ctx.storage.links_urls.rows.values()].some((r) => r.url === "https://new.test/"));
	assert.deepEqual(refs.get(await id("e4", "https://x.test/4")), before.get(await id("e4", "https://x.test/4")), "untouched rows keep their seenAt");
});

test("scan cleanup: references of trashed or deleted entries, or of collections without link fields, are removed", async () => {
	const entries = Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, slug: `e${i}`, status: i === 3 ? "draft" : "published", data: { title: `E${i}`, body: [block("1", `https://x.test/${i}`), block("2", "https://shared.test/")] } }));
	const ctx = fakeCtx({ entries });
	await fullScan(ctx);
	assert.equal(ctx.storage.links_refs.rows.size, 8);
	// A reference left by a collection that no longer has link fields (or no longer exists).
	await ctx.storage.links_refs.put(`old/z|${await store.urlId("https://old.test/")}`, { urlId: await store.urlId("https://old.test/"), entryKey: "old/z", collection: "old", entryId: "z", title: "Z", entryStatus: "published", kinds: ["text"], anchors: [], count: 1, seenAt: "2026-01-01T00:00:00.000Z" });
	await ctx.storage.links_urls.put(await store.urlId("https://old.test/"), { url: "https://old.test/", ignored: false, status: "unchecked", internal: false });
	entries[1].trashed = true; // trashed without the hook running
	entries.splice(2, 1); // e2 deleted for good

	assert.deepEqual(await fullScan(ctx), [], "nothing rewritten");
	const keys = new Set([...ctx.storage.links_refs.rows.values()].map((r) => r.entryKey));
	assert.deepEqual([...keys].sort(), ["posts/e0", "posts/e3"], "the draft stays; trashed, deleted and old-collection refs go");
	const left = [...ctx.storage.links_urls.rows.values()].map((r) => r.url).sort();
	assert.deepEqual(left, ["https://shared.test/", "https://x.test/0", "https://x.test/3"], "orphaned URL rows dropped");
	const counts = await store.getCounts(ctx, 0);
	assert.equal(counts.all, 3);
	assert.equal(counts.unchecked, 3);
});

test("scan cleanup: an empty collection listing or unreadable content keeps every reference", async () => {
	const entries = Array.from({ length: 3 }, (_, i) => ({ id: `e${i}`, slug: `e${i}`, status: "published", data: { title: `E${i}`, body: [block("1", `https://x.test/${i}`)] } }));
	const ctx = fakeCtx({ entries });
	await fullScan(ctx);
	assert.equal(ctx.storage.links_refs.rows.size, 3);
	entries.splice(2, 1); // e2 is gone, so a working cleanup would drop one reference

	const schema = ctx.schema;
	ctx.schema = { listCollections: async () => [] };
	store.resetLinkCollections();
	assert.deepEqual(await store.staleEntries(ctx), [], "no collections listed: nothing is stale");
	ctx.schema = undefined;
	store.resetLinkCollections();
	assert.deepEqual(await store.staleEntries(ctx), [], "no schema access: nothing is stale");
	ctx.schema = schema;
	store.resetLinkCollections();

	const content = ctx.content;
	ctx.content = { list: content.list };
	assert.deepEqual(await store.staleEntries(ctx), [], "content can't be read: nothing is stale");
	ctx.content = undefined;
	assert.deepEqual(await store.staleEntries(ctx), [], "no content access: nothing is stale");
	ctx.content = content;
	assert.equal(ctx.storage.links_refs.rows.size, 3);
	assert.ok(ctx.logs.length >= 4, "each case is logged");

	assert.deepEqual(await store.staleEntries(ctx), ["posts/e2"], "with everything readable, the deleted entry is stale");
});

// ── Schedule (off by default; daily / weekly / monthly runs) ─────

const { linksModule, isRunDue, RUN_KEY } = await import("../src/links/module.ts");
const { linksPack } = await import("../src/links/pack.ts");
const { composeHooks } = await import("../src/core/compose.ts");

const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** fakeCtx plus settings, with every storage/KV/settings read counted. */
function scheduleCtx({ features = { links: true, "links.check": true }, frequency, entries } = {}) {
	const ctx = fakeCtx({ entries });
	const reads = [];
	const values = new Map([["features", features]]);
	if (frequency) values.set("linksFrequency", frequency);
	ctx.settings = {
		async get(k) {
			reads.push(`settings:${k}`);
			return values.get(k) ?? null;
		},
		async set(k, v) {
			values.set(k, v);
		},
	};
	const count = (name, target) =>
		new Proxy(target, {
			get(t, prop) {
				const v = t[prop];
				if (typeof v !== "function") return v;
				return (...args) => {
					reads.push(`${name}.${String(prop)}`);
					return v.apply(t, args);
				};
			},
		});
	ctx.kv = count("kv", ctx.kv);
	ctx.storage = { links_urls: count("urls", ctx.storage.links_urls), links_refs: count("refs", ctx.storage.links_refs) };
	ctx.reads = reads;
	return ctx;
}

const cron = (name, ctx) => {
	const { hooks } = composeHooks([linksPack()], { tasks: [] });
	return hooks.cron.handler({ name }, ctx);
};

test("schedule: tasks run hourly and only while Scheduled link checking is on", async () => {
	const pack = linksPack();
	assert.deepEqual(
		pack.tasks.map((t) => [t.name, t.schedule, t.feature]),
		[
			["links-scan", "@hourly", "links.check"],
			["links-check", "@hourly", "links.check"],
		],
	);
	assert.equal(pack.features.find((f) => f.id === "links.check").default, false);
	for (const features of [{ links: true }, { links: true, "links.check": false }, { links: false, "links.check": true }]) {
		const ctx = scheduleCtx({ features, entries: [{ id: "a", data: { title: "A", body: [block("1", "https://x.test/")] } }] });
		await cron("links-scan", ctx);
		await cron("links-check", ctx);
		assert.deepEqual(ctx.reads, ["settings:features", "settings:features"], "off: nothing but the switch is read");
	}
});

test("schedule: isRunDue for daily, weekly (default) and monthly", () => {
	const now = Date.now();
	for (const f of ["daily", "weekly", "monthly"]) assert.equal(isRunDue(f, null, now), true, `${f}: never ran`);
	assert.equal(isRunDue("daily", ago(24 * 3_600_000 - 2 * 60_000), now), true, "within a few minutes of cron drift");
	assert.equal(isRunDue("daily", ago(23.5 * 3_600_000), now), false, "not an hour early (daily runs don't creep earlier)");
	assert.equal(isRunDue("daily", ago(20 * 3_600_000), now), false);
	assert.equal(isRunDue("weekly", ago(6 * DAY), now), false);
	assert.equal(isRunDue("weekly", ago(7 * DAY), now), true);
	assert.equal(isRunDue("monthly", ago(8 * DAY), now), false);
	assert.equal(isRunDue("monthly", ago(30 * DAY), now), true);
});

test("schedule: a weekly run that isn't due reads one state row and the frequency, nothing else", async () => {
	const ctx = scheduleCtx();
	await ctx.kv.set(RUN_KEY, { startedAt: ago(2 * DAY), phase: "done" });
	ctx.reads.length = 0;
	await cron("links-scan", ctx);
	await cron("links-check", ctx);
	assert.deepEqual(ctx.reads, ["settings:features", "kv.get", "settings:linksFrequency", "settings:features", "kv.get"]);
});

test("schedule: a due run scans, then checks due links over the next ticks, then waits for the next one", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(null, { status: 200 });
	try {
		const entries = [{ id: "a", slug: "a", status: "published", data: { title: "A", body: [block("1", "https://x.test/"), block("2", "https://y.test/")] } }];
		const ctx = scheduleCtx({ entries }); // No frequency saved: weekly.
		await ctx.kv.set(RUN_KEY, { startedAt: ago(8 * DAY), phase: "done" });
		await cron("links-check", ctx);
		assert.equal(ctx.storage.links_urls.rows.size, 0, "checking waits for the scan");
		await cron("links-scan", ctx);
		assert.equal(ctx.storage.links_urls.rows.size, 2, "scanned");
		assert.equal((await ctx.kv.get(RUN_KEY)).phase, "check");
		await cron("links-check", ctx);
		const rows = [...ctx.storage.links_urls.rows.values()];
		assert.ok(rows.every((r) => r.status === "ok" && r.checkedAt), "checked");
		const run = await ctx.kv.get(RUN_KEY);
		assert.equal(run.phase, "done");
		assert.ok(Date.now() - Date.parse(run.startedAt) < 60_000, "the new run's start is recorded");
		// Next tick: not due again for a week.
		ctx.reads.length = 0;
		await cron("links-scan", ctx);
		assert.ok(!ctx.reads.some((r) => r.startsWith("urls.") || r.startsWith("refs.")), "no link reads between runs");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("schedule: daily and monthly frequencies", async () => {
	const daily = scheduleCtx({ frequency: "daily", entries: [] });
	await daily.kv.set(RUN_KEY, { startedAt: ago(25 * 3_600_000), phase: "done" });
	await cron("links-scan", daily);
	assert.notEqual((await daily.kv.get(RUN_KEY)).phase, "done", "daily: a day later a run starts");

	const monthly = scheduleCtx({ frequency: "monthly", entries: [] });
	await monthly.kv.set(RUN_KEY, { startedAt: ago(10 * DAY), phase: "done" });
	await cron("links-scan", monthly);
	assert.equal((await monthly.kv.get(RUN_KEY)).phase, "done", "monthly: not after 10 days");
	await monthly.kv.set(RUN_KEY, { startedAt: ago(31 * DAY), phase: "done" });
	await cron("links-scan", monthly);
	assert.notEqual((await monthly.kv.get(RUN_KEY)).phase, "done", "monthly: after 30 days");
});

test("schedule: Scan content and Check now still work on demand", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(null, { status: 200 });
	try {
		const entries = [{ id: "a", slug: "a", status: "published", data: { title: "A", body: [block("1", "https://x.test/")] } }];
		const ctx = scheduleCtx({ entries });
		const { routes } = linksModule();
		ctx.input = { restart: true };
		const scan = await routes["links/scan"].handler(ctx);
		assert.equal(scan.status, "idle");
		assert.equal(ctx.storage.links_urls.rows.size, 1);
		ctx.input = {};
		const run = await routes["links/recheck"].handler(ctx);
		assert.equal(run.checked, 1);
		assert.equal(await ctx.kv.get(RUN_KEY), null, "manual actions don't start a scheduled run");
	} finally {
		globalThis.fetch = realFetch;
	}
});

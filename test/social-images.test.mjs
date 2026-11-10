// Run: node --test test/social-images.test.mjs
// Social Images: the template (escaped, self-contained), the image's hash and key,
// rendering through Browser Run (binding or REST API, with deadlines and limits),
// storing in the media bucket, and og:image through Schema & Social's hook.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeCollection, fakeKv, fakeSettings, quietLog } from "./fixtures/fake-plugin.mjs";

await import("../src/schema/pack.ts");
await import("../src/social/pack.ts");
const template = await import("../src/social/template.ts");
const render = await import("../src/social/render.ts");
const { hasOwnImage, renderPending } = await import("../src/social/pack.ts");
const { schemaContributions, invalidateSchemaConfig } = await import("../src/schema/module.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = () => new Response(PNG, { headers: { "content-type": "image/png" } });

test("the template escapes the title and site name, and takes only data: or https logos", () => {
	const html = template.socialImageHtml({ title: `<img src=x onerror=alert(1)> "Quotes" & more`, siteName: "Joe's <Site>", logo: "javascript:alert(1)", settings: template.TEMPLATE_DEFAULTS });
	assert.doesNotMatch(html, /<img src=x|javascript:/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;Quotes&quot; &amp; more/);
	assert.match(html, /Joe&#39;s &lt;Site&gt;/);
	assert.doesNotMatch(html, /<script/i);
	const withLogo = template.socialImageHtml({ title: "T", siteName: "S", logo: "data:image/png;base64,AAAA", settings: template.TEMPLATE_DEFAULTS });
	assert.match(withLogo, /<img src="data:image\/png;base64,AAAA" alt="">/);
	const noLogo = template.socialImageHtml({ title: "T", siteName: "S", logo: "data:image/png;base64,AAAA", settings: { ...template.TEMPLATE_DEFAULTS, showLogo: false, showSiteName: false } });
	assert.doesNotMatch(noLogo, /<img|<span>S<\/span>/);
	assert.match(withLogo, /width:1200px;height:630px/);
});

test("colors must be hex; longer titles get smaller type", () => {
	const t = template.normalizeTemplate({ background: "red; } body { display:none", text: "#FFF", layout: "center", showLogo: "yes" });
	assert.equal(t.background, template.TEMPLATE_DEFAULTS.background);
	assert.equal(t.text, "#fff");
	assert.equal(t.layout, "center");
	assert.equal(t.showLogo, true);
	assert.ok(template.titleSize("Short") > template.titleSize("A".repeat(100)));
});

test("the hash changes with the title, site name, logo and template, and names the file", async () => {
	const base = { title: "Hello", siteName: "Site", logoKey: "logo.png:1", settings: template.TEMPLATE_DEFAULTS };
	const h = await template.imageHash(base);
	assert.match(h, /^[0-9a-f]{16}$/);
	assert.equal(await template.imageHash({ ...base }), h);
	for (const change of [{ title: "Hello!" }, { siteName: "Other" }, { logoKey: "logo.png:2" }, { settings: { ...template.TEMPLATE_DEFAULTS, accent: "#000000" } }]) assert.notEqual(await template.imageHash({ ...base, ...change }), h);
	assert.equal(template.imageKey("posts", "e1", h), `coywolf-og/posts/e1-${h}.png`);
});

test("an entry with an SEO image or an image field keeps its own", () => {
	const fields = [{ slug: "cover", type: "image" }];
	assert.equal(hasOwnImage({ id: "a", slug: "a", status: "published", data: {}, seo: { image: "/x.jpg" } }, { fields }), true);
	assert.equal(hasOwnImage({ id: "a", slug: "a", status: "published", data: { cover: { id: "m1" } } }, { fields }), true);
	assert.equal(hasOwnImage({ id: "a", slug: "a", status: "published", data: { cover: null } }, { fields }), false);
});

function fakeBucket() {
	const objects = new Map();
	return {
		objects,
		async put(key, value, options) {
			objects.set(key, { value, options });
		},
		async get(key) {
			return objects.get(key) ? { size: 10, etag: "e", httpMetadata: { contentType: "image/png" }, arrayBuffer: async () => new ArrayBuffer(10) } : null;
		},
		async delete(key) {
			objects.delete(key);
		},
	};
}

function fakeCtx(entries = [], extra = {}) {
	return {
		kv: fakeKv(),
		settings: fakeSettings({ features: { _defaults036: true, schema: true, socialImages: true } }),
		storage: { socialImages: fakeCollection() },
		log: quietLog(),
		site: { url: "https://example.com", name: "Example" },
		schema: {
			async listCollections() {
				return [{ slug: "posts", label: "Posts", routable: true, hidden: false, titleField: "title", fields: [{ slug: "title", type: "string" }, { slug: "cover", type: "image" }] }];
			},
		},
		content: {
			async get(_c, id) {
				return entries.find((e) => e.id === id) ?? null;
			},
		},
		...extra,
	};
}

const rc = (bucket, quickAction) => ({ renderer: async () => ({ kind: "binding", browser: { quickAction } }), bucket, siteName: "Example", logo: { src: null, key: null }, template: template.TEMPLATE_DEFAULTS });

test("render: stored in the media bucket once per title and template; the image before last is deleted", async () => {
	const ctx = fakeCtx();
	const bucket = fakeBucket();
	const calls = [];
	const r = rc(bucket, async (action, options) => {
		calls.push({ action, options });
		return png();
	});
	const first = await render.renderEntry(ctx, r, { collection: "posts", id: "e1", title: "First title" });
	assert.equal(first.status, "ready");
	assert.equal(calls[0].action, "screenshot");
	assert.deepEqual(calls[0].options.viewport, { width: 1200, height: 630, deviceScaleFactor: 1 });
	assert.match(calls[0].options.html, /First title/);
	assert.equal(bucket.objects.get(first.key).options.httpMetadata.contentType, "image/png");
	assert.match(bucket.objects.get(first.key).options.httpMetadata.cacheControl, /immutable/);

	await render.renderEntry(ctx, r, { collection: "posts", id: "e1", title: "First title" });
	assert.equal(calls.length, 1, "same title and template: no new render");

	const second = await render.renderEntry(ctx, r, { collection: "posts", id: "e1", title: "Second title" });
	assert.equal(second.previousKey, first.key, "kept: cached pages may still point to it");
	assert.ok(bucket.objects.has(first.key));
	const third = await render.renderEntry(ctx, r, { collection: "posts", id: "e1", title: "Third title" });
	assert.ok(!bucket.objects.has(first.key), "two changes later, it's gone");
	assert.ok(bucket.objects.has(second.key) && bucket.objects.has(third.key));
});

test("render failures: a rate limit keeps it pending without counting; three failures mark it failed; no PNG is refused", async () => {
	const ctx = fakeCtx();
	const bucket = fakeBucket();
	const limited = rc(bucket, async () => new Response(JSON.stringify({ errors: [{ message: "Rate limited" }] }), { status: 429, headers: { "content-type": "application/json" } }));
	await assert.rejects(render.renderEntry(ctx, limited, { collection: "posts", id: "e1", title: "T" }), (e) => e.status === 429 && /Rate limited/.test(e.message));
	let doc = await ctx.storage.socialImages.get("posts:e1");
	assert.equal(doc.status, "pending");
	assert.equal(doc.attempts, 0);
	// Browser Run not set up: looked up only when a render is needed, and not counted against the entry either.
	const unset = { ...rc(bucket, async () => png()), renderer: async () => Promise.reject(new render.RenderError("Add a token", render.NOT_SET_UP)) };
	await assert.rejects(render.renderEntry(ctx, unset, { collection: "posts", id: "e1", title: "T" }), /Add a token/);
	assert.equal((await ctx.storage.socialImages.get("posts:e1")).attempts, 0);
	const broken = rc(bucket, async () => new Response("<html>", { headers: { "content-type": "image/png" } }));
	for (let i = 0; i < 3; i++) await assert.rejects(render.renderEntry(ctx, broken, { collection: "posts", id: "e1", title: "T" }), /didn't return a PNG/);
	doc = await ctx.storage.socialImages.get("posts:e1");
	assert.equal(doc.status, "failed");
	assert.equal(bucket.objects.size, 0);
});

test("two renders of one entry at once: a failure can't clobber the other's ready image", async () => {
	const ctx = fakeCtx();
	const bucket = fakeBucket();
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	// The first render is slow and then fails; the second succeeds meanwhile.
	const slowFail = rc(bucket, async () => {
		await gate;
		return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
	});
	const first = render.renderEntry(ctx, slowFail, { collection: "posts", id: "e1", title: "Title" }).catch((e) => e);
	await new Promise((r) => setTimeout(r, 5));
	const ok = await render.renderEntry(ctx, rc(bucket, async () => png()), { collection: "posts", id: "e1", title: "Title" });
	release();
	assert.ok((await first) instanceof Error);
	const doc = await ctx.storage.socialImages.get("posts:e1");
	assert.equal(doc.status, "ready");
	assert.equal(doc.key, ok.key);
});

test("a save reads the entry as published: a draft's title is never stored (and so never becomes the image's alt)", async () => {
	const { socialImagesPack } = await import("../src/social/pack.ts");
	const live = { id: "e1", slug: "one", status: "published", data: { title: "Published title" } };
	const ctx = fakeCtx([live]);
	await ctx.storage.socialImages.put("posts:e1", { collection: "posts", id: "e1", title: "Published title", key: "coywolf-og/posts/e1-old.png", hash: "old", status: "ready", note: null, attempts: 0, updatedAt: "", renderedAt: "" });
	const hooks = socialImagesPack().hooks;
	const draftSave = { collection: "posts", content: { id: "e1", status: "published", data: { title: "Draft title, not published yet" } } };
	await hooks["content:afterSave"](draftSave, ctx);
	await hooks["content:afterPublish"](draftSave, ctx);
	await new Promise((r) => setTimeout(r, 20));
	const doc = await ctx.storage.socialImages.get("posts:e1");
	assert.equal(doc.title, "Published title");
	assert.equal(doc.status, "ready", "the live title didn't change: nothing to do");
	assert.ok(!JSON.stringify([...ctx.storage.socialImages.rows.values()]).includes("Draft title"));
});

test("a save while a check of the same entry runs isn't dropped: the entry is checked once more after it", async () => {
	const { socialImagesPack } = await import("../src/social/pack.ts");
	const live = { id: "e2", slug: "two", status: "published", data: { title: "Two" } };
	const ctx = fakeCtx([live]);
	let reads = 0;
	const get = ctx.content.get;
	ctx.content.get = async (...args) => {
		reads++;
		await new Promise((r) => setTimeout(r, 5));
		return get(...args);
	};
	const hooks = socialImagesPack().hooks;
	const event = { collection: "posts", content: { id: "e2", status: "published" } };
	await hooks["content:afterSave"](event, ctx);
	await hooks["content:afterPublish"](event, ctx);
	await hooks["content:afterPublish"](event, ctx);
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(reads, 2, "one check, then one more for the saves that came during it");
});

test("a deleted entry's images and record are removed", async () => {
	const { socialImagesPack } = await import("../src/social/pack.ts");
	const ctx = fakeCtx();
	await ctx.storage.socialImages.put("posts:e1", { collection: "posts", id: "e1", title: "T", key: "k1", previousKey: "k0", hash: "h", status: "ready" });
	await socialImagesPack().hooks["content:afterDelete"]({ collection: "posts", id: "e1" }, ctx);
	assert.equal(await ctx.storage.socialImages.get("posts:e1"), null);
	const bucket = fakeBucket();
	await bucket.put("k1", PNG);
	await render.removeEntryImage(ctx, bucket, "posts", "nope");
	assert.ok(bucket.objects.has("k1"), "nothing to remove for an entry without a record");
});

test("Retry-After and a BROWSER binding that can't take Quick Actions (an old compatibility date) are told apart", async () => {
	assert.equal(render.retryAfterMs("12"), 12_000);
	assert.equal(render.retryAfterMs(new Date(Date.now() + 5_000).toUTCString()) > 0, true);
	assert.equal(render.retryAfterMs("soon"), null);
	const limited = async () => new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "11" } });
	await assert.rejects(render.screenshot({ kind: "api", token: "t0ken-value-12", accountId: "a".repeat(32), fetch: limited }, "<p>"), (e) => e.status === 429 && e.retryAfterMs === 11_000);
	const old = { kind: "binding", browser: { quickAction: async () => Promise.reject(new TypeError('The RPC receiver does not implement the method "quickAction".')) } };
	await assert.rejects(render.screenshot(old, "<p>"), (e) => e.status === render.NOT_SET_UP && /compatibility_date 2026-03-24/.test(e.message));
});

test("the REST API: the account's screenshot endpoint with the token, the old path on a 404, the token never in errors", async () => {
	const requests = [];
	const fetch = async (url, init) => {
		requests.push({ url, init });
		if (url.includes("/browser-run/")) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
		return png();
	};
	const out = await render.screenshot({ kind: "api", token: "secret-token-123456", accountId: "a".repeat(32), fetch }, "<html></html>");
	assert.deepEqual([...out], [...PNG]);
	assert.deepEqual(requests.map((r) => r.url), [`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/browser-run/screenshot`, `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/browser-rendering/screenshot`]);
	assert.equal(requests[0].init.headers.Authorization, "Bearer secret-token-123456");
	assert.ok(requests[0].init.signal, "every call can be aborted at its deadline");

	const denied = async () => new Response(JSON.stringify({ errors: [{ message: "Authentication error for secret-token-123456" }] }), { status: 403, headers: { "content-type": "application/json" } });
	await assert.rejects(render.screenshot({ kind: "api", token: "secret-token-123456", accountId: "a".repeat(32), fetch: denied }, "<html></html>"), (e) => !e.message.includes("secret-token-123456") && /Browser Run → Edit/.test(e.message));
});

test("how Browser Run is reached: a binding first, else a token and account, else why not", async () => {
	const ctx = fakeCtx();
	assert.equal((await render.renderer(ctx, render.normalizeSocialSettings({}), { BROWSER: { quickAction: async () => png() } })).kind, "binding");
	const none = await render.renderer(ctx, render.normalizeSocialSettings({}), {});
	assert.equal(none.kind, "none");
	assert.match(none.reason, /Browser Run → Edit/);
	const api = await render.renderer(ctx, render.normalizeSocialSettings({ accountId: "B".repeat(32) }), { BROWSER_RUN_API_TOKEN: "t0ken-value" });
	assert.equal(api.kind, "api");
	assert.equal(api.accountId, "b".repeat(32));
});

test("pending entries: published ones without their own image are made; the others are skipped", async () => {
	const entries = [
		{ id: "e1", slug: "one", status: "published", data: { title: "One" } },
		{ id: "e2", slug: "two", status: "published", data: { title: "Two", cover: { id: "m1" } } },
		{ id: "e3", slug: "three", status: "draft", data: { title: "Three" } },
	];
	const bucket = fakeBucket();
	const ctx = fakeCtx(entries);
	for (const e of entries) await ctx.storage.socialImages.put(`posts:${e.id}`, { collection: "posts", id: e.id, title: "", key: null, hash: null, status: "pending", note: null, attempts: 0, updatedAt: "2026-01-01", renderedAt: null });
	// No Worker env in tests: render through a context built by hand, as renderPending would.
	const out = { rendered: 0, skipped: 0 };
	const r = rc(bucket, async () => png());
	for (const e of entries) {
		if (e.status !== "published" || hasOwnImage(e, { fields: [{ slug: "cover", type: "image" }] })) out.skipped++;
		else {
			await render.renderEntry(ctx, r, { collection: "posts", id: e.id, title: e.data.title });
			out.rendered++;
		}
	}
	assert.deepEqual(out, { rendered: 1, skipped: 2 });
	// Without bindings (as in tests), renderPending says why it can't render instead of failing.
	const result = await renderPending(ctx, { limit: 10, deadline: Date.now() + 5000 });
	assert.match(result.stopped ?? "", /Browser Run|media bucket/);
});

// ── og:image through Schema & Social ─────────────────────────────

function schemaCtx(docs) {
	const store = (rows) => ({ get: async (id) => rows[id] ?? null, getMany: async (ids) => new Map(ids.filter((id) => rows[id]).map((id) => [id, rows[id]])), query: async () => ({ items: [], hasMore: false }) });
	return {
		site: { url: "https://example.com", name: "Example", locale: "en-US" },
		log: quietLog(),
		settings: { list: async () => [], get: async (key) => (key === "features" ? { _defaults036: true, schema: true, socialImages: true, "schema.openGraph": true } : null) },
		storage: { schemaDocs: store({}), schemaEntries: store({}), socialImages: store(docs) },
		media: { get: async () => null },
		content: { get: async () => null },
	};
}

const page = (over = {}) => ({
	url: "https://example.com/my-post/",
	path: "/my-post/",
	locale: "en-US",
	kind: "content",
	pageType: "article",
	title: "My Post | Example",
	pageTitle: "My Post",
	description: null,
	canonical: "https://example.com/my-post/",
	image: null,
	content: { collection: "posts", id: "e1", slug: "my-post" },
	seo: { ogImage: null, robots: null },
	siteName: "Example",
	siteUrl: "https://example.com",
	...over,
});

test("og:image: the generated image for an entry without its own, with its size, type and a large card", async () => {
	invalidateSchemaConfig?.();
	const ctx = schemaCtx({ "posts:e1": { collection: "posts", id: "e1", title: "My Post", key: "coywolf-og/posts/e1-abc.png", status: "ready" } });
	const out = await schemaContributions(ctx, page(), {});
	const prop = (name) => out.find((c) => c.property === name)?.content;
	assert.equal(prop("og:image"), "https://example.com/_emdash/api/media/file/coywolf-og/posts/e1-abc.png");
	assert.equal(prop("og:image:width"), "1200");
	assert.equal(prop("og:image:height"), "630");
	assert.equal(prop("og:image:type"), "image/png");
	assert.equal(prop("og:image:alt"), "My Post");
	assert.equal(out.find((c) => c.name === "twitter:card")?.content, "summary_large_image");

	// An image the theme passes wins (a body image, a file field…), unless it's listed as a theme default (not here).
	const themed = await schemaContributions(ctx, page({ image: "https://example.com/uploads/body-photo.jpg" }), {});
	assert.notEqual(themed.find((c) => c.property === "og:image")?.content, prop("og:image"));
	// The SEO image always wins; an entry that got an image of its own since ("skipped") keeps it; no record, nothing.
	const seo = await schemaContributions(ctx, page({ seo: { ogImage: "https://example.com/seo.jpg", robots: null } }), {});
	assert.notEqual(seo.find((c) => c.property === "og:image")?.content, prop("og:image"));
	const skipped = schemaCtx({ "posts:e1": { collection: "posts", id: "e1", title: "My Post", key: "coywolf-og/posts/e1-abc.png", status: "skipped" } });
	assert.equal((await schemaContributions(skipped, page(), {})).find((c) => c.name === "twitter:card"), undefined);
	const none = await schemaContributions(schemaCtx({}), page({ content: { collection: "posts", id: "e9", slug: "x" } }), {});
	assert.equal(none.find((c) => c.name === "twitter:card"), undefined);
});

test("theme default images: http(s) URLs or paths, compared by path, so a theme's share image counts as none", async () => {
	const { parseDefaultImages, isThemeDefault } = await import("../src/social/store.ts");
	assert.deepEqual(parseDefaultImages(["/theme/images/share.png", "https://cdn.example/x.png", "javascript:alert(1)", "//evil.test/x.png", "/theme/images/share.png", 42]), ["/theme/images/share.png", "https://cdn.example/x.png"]);
	const defaults = parseDefaultImages(["/theme/images/share.png"]);
	assert.equal(isThemeDefault("https://example.com/theme/images/share.png?v=2", defaults), true);
	assert.equal(isThemeDefault("https://example.com/theme/images/other.png", defaults), false);
	assert.equal(isThemeDefault(null, defaults), false);
	assert.equal(render.normalizeSocialSettings({ defaultImages: ["/a.png", "bad"] }).defaultImages.join(), "/a.png");
});

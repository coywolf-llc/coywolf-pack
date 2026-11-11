// Run: node --test test/videos.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	MAX_CAPTION_BYTES,
	RecentKeys,
	absoluteUrl,
	aspectRatio,
	buildVideoObject,
	buildVideoSitemap,
	clockDuration,
	customerHostFromUrl,
	findVideoBlocks,
	hmacHex,
	indexSource,
	isImageUrl,
	isoDuration,
	normalizeCustomerHost,
	playerConfig,
	playerSrc,
	posterUrl,
	utf8Bytes,
	verifyWebhookSignature,
	vttToTranscript,
} from "../src/videos/lib.ts";

const UID = "0123456789abcdef0123456789abcdef";
const UID2 = "fedcba9876543210fedcba9876543210";
const HOST = "customer-abc123.cloudflarestream.com";

test("isoDuration", () => {
	assert.equal(isoDuration(0), null);
	assert.equal(isoDuration(-5), null);
	assert.equal(isoDuration("nope"), null);
	assert.equal(isoDuration(0.4), "PT1S");
	assert.equal(isoDuration(45), "PT45S");
	assert.equal(isoDuration(60), "PT1M");
	assert.equal(isoDuration(61.6), "PT1M2S");
	assert.equal(isoDuration(3600), "PT1H");
	assert.equal(isoDuration(3723), "PT1H2M3S");
	assert.equal(isoDuration(7205), "PT2H5S");
});

test("clockDuration", () => {
	assert.equal(clockDuration(0), "");
	assert.equal(clockDuration(65), "1:05");
	assert.equal(clockDuration(3723), "1:02:03");
});

test("customer host normalization", () => {
	assert.equal(normalizeCustomerHost("customer-ABC123.cloudflarestream.com"), HOST);
	assert.equal(normalizeCustomerHost(`https://${HOST}/xyz/iframe`), HOST);
	assert.equal(normalizeCustomerHost("abc123"), HOST);
	assert.equal(normalizeCustomerHost("evil.example.com"), null);
	assert.equal(normalizeCustomerHost(""), null);
	assert.equal(customerHostFromUrl(`https://${HOST}/${UID}/thumbnails/thumbnail.jpg`), HOST);
	assert.equal(customerHostFromUrl("https://videodelivery.net/x"), null);
});

test("findVideoBlocks walks Portable Text at any depth, dedupes, reads WP markers", () => {
	const marker = `<div data-wb-block="cloudflare-stream" data-wb-attrs="{&quot;id&quot;:&quot;${UID2}&quot;,&quot;host&quot;:&quot;${HOST}&quot;,&quot;name&quot;:&quot;Loop&quot;}"></div>`;
	const data = {
		title: "Post",
		content: [
			{ _type: "block", children: [{ _type: "span", text: "hello" }] },
			{ _type: "coywolf-video", _key: "a", uid: UID, title: "  Intro ", posterTime: 3, posterImage: "javascript:alert(1)" },
			{ _type: "columns", columns: [{ content: [{ _type: "coywolf-video", uid: UID, title: "dupe" }] }] },
			{ _type: "coywolf-video", uid: "not-a-uid" },
			{ _type: "htmlBlock", html: marker },
			{ _type: "htmlBlock", html: "<p>other</p>" },
		],
		sidebar: [{ _type: "coywolf-video", uid: UID2 }],
	};
	const refs = findVideoBlocks(data);
	assert.deepEqual(refs, [
		{ uid: UID, title: "Intro", posterTime: 3 },
		{ uid: UID2, title: "Loop", legacy: true },
	]);
	assert.deepEqual(findVideoBlocks(null), []);
	assert.deepEqual(findVideoBlocks({ content: [] }), []);
});

test("player config and src", () => {
	const gif = playerConfig({ preset: "gif", controls: true });
	assert.equal(gif.autoplay && gif.loop && gif.muted && !gif.controls, true);
	assert.equal(playerConfig({ host: HOST, id: UID }).gif, true, "legacy markers default to the GIF preset");
	const std = playerConfig({ uid: UID, autoplay: true });
	assert.equal(std.muted, true, "autoplay forces muted");
	assert.equal(std.controls, true);
	const src = new URL(playerSrc(HOST, UID, gif, { startTime: 12.7, poster: "https://x/p.jpg", accent: "#ff0000", background: "nope" }));
	assert.equal(src.origin + src.pathname, `https://${HOST}/${UID}/iframe`);
	assert.equal(src.searchParams.get("autoplay"), "true");
	assert.equal(src.searchParams.get("controls"), "false");
	assert.equal(src.searchParams.get("preload"), "auto");
	assert.equal(src.searchParams.get("startTime"), "12s");
	assert.equal(src.searchParams.get("primaryColor"), "#ff0000");
	assert.equal(src.searchParams.get("letterboxColor"), "transparent");
	assert.equal(src.searchParams.get("poster"), "https://x/p.jpg");
	assert.ok(playerSrc(null, UID, std).startsWith(`https://iframe.videodelivery.net/${UID}?`));
});

test("poster and aspect ratio", () => {
	assert.equal(posterUrl(HOST, UID, { posterImage: "https://img/x.jpg" }), "https://img/x.jpg");
	assert.equal(posterUrl(HOST, UID, { posterTime: 5 }, { posterImage: "https://img/y.jpg" }), `https://${HOST}/${UID}/thumbnails/thumbnail.jpg?time=5s&width=1200`);
	assert.equal(posterUrl(HOST, UID, {}, { posterImage: "https://img/y.jpg" }), "https://img/y.jpg");
	assert.equal(posterUrl(null, UID, {}, { posterTime: 2 }, 320), `https://videodelivery.net/${UID}/thumbnails/thumbnail.jpg?time=2s&width=320`);
	assert.equal(aspectRatio(1920, 1080), "1920 / 1080");
	assert.equal(aspectRatio(0, 0, 56.25), "100 / 56.25");
	assert.equal(aspectRatio(), "16 / 9");
});

test("VideoObject schema", () => {
	const schema = buildVideoObject({
		ref: { uid: UID, caption: "<b>Block</b> description &amp; more" },
		video: {
			uid: UID,
			name: "Stream name",
			duration: 125,
			created: "2026-01-02T03:04:05Z",
			posterTime: 4,
			downloadUrl: "https://dl/x.mp4",
			captions: [{ language: "en", label: "English" }],
			transcript: "Hello there world",
		},
		host: HOST,
		siteUrl: "https://example.com/",
		page: { title: "Page", description: "Page desc", publishedTime: "2025-01-01T00:00:00Z" },
		counts: { plays: 10, likes: 3 },
		likesEnabled: true,
		captionsEnabled: true,
	});
	assert.equal(schema["@type"], "VideoObject");
	assert.equal(schema.name, "Stream name");
	assert.equal(schema.description, "Block description & more");
	assert.deepEqual(schema.thumbnailUrl, [`https://${HOST}/${UID}/thumbnails/thumbnail.jpg?time=4s&width=1200`]);
	assert.equal(schema.duration, "PT2M5S");
	assert.equal(schema.uploadDate, "2026-01-02T03:04:05Z");
	assert.equal(schema.embedUrl, `https://${HOST}/${UID}/iframe`);
	assert.equal(schema.contentUrl, "https://dl/x.mp4");
	assert.equal(schema.interactionStatistic.length, 2);
	assert.equal(schema.interactionStatistic[0].userInteractionCount, 10);
	assert.equal(schema.caption.contentUrl, `https://example.com/coywolf-video-captions/${UID}/en.vtt`);
	assert.equal(schema.transcript, "Hello there world");

	const bare = buildVideoObject({ ref: { uid: UID }, host: null, siteUrl: "https://e.com", page: { title: "Page title" } });
	assert.equal(bare.name, "Page title");
	assert.equal(bare.description, "Page title");
	assert.equal("duration" in bare, false);
	assert.equal("contentUrl" in bare, false);
	assert.equal("interactionStatistic" in bare, false);
	assert.equal("uploadDate" in bare, false);
	assert.equal("caption" in bare, false);
});

test("video sitemap XML", () => {
	const xml = buildVideoSitemap([
		{
			loc: "https://example.com/a?x=1&y=2",
			videos: [
				{
					thumbnail: "https://t/1.jpg?time=0s&width=1200",
					title: "Tom & Jerry <live>",
					description: "",
					playerLoc: `https://${HOST}/${UID}/iframe`,
					contentLoc: "https://dl/x.mp4",
					duration: 90.4,
					viewCount: 7,
					publicationDate: "2026-01-02T03:04:05Z",
				},
			],
		},
		{ loc: "https://example.com/empty", videos: [] },
	]);
	assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
	assert.ok(xml.includes('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'));
	assert.ok(xml.includes("<loc>https://example.com/a?x=1&amp;y=2</loc>"));
	assert.ok(xml.includes("<video:title>Tom &amp; Jerry &lt;live&gt;</video:title>"));
	assert.ok(xml.includes("<video:description>Tom &amp; Jerry &lt;live&gt;</video:description>"), "empty description falls back to the title");
	assert.ok(xml.includes("<video:duration>90</video:duration>"));
	assert.ok(xml.includes("<video:view_count>7</video:view_count>"));
	assert.ok(!xml.includes("example.com/empty"));
	const order = ["thumbnail_loc", "title", "description", "content_loc", "player_loc", "duration", "view_count", "publication_date"].map((t) => xml.indexOf(`<video:${t}>`));
	assert.deepEqual([...order].sort((a, b) => a - b), order, "elements follow the schema sequence");
});

test("VTT transcript", () => {
	const vtt = "﻿WEBVTT\n\nNOTE a comment\n\n1\n00:00:00.000 --> 00:00:02.000\n<v Bob>Hello &amp; welcome</v>\n\n00:00:02.000 --> 00:00:04.000\nto the   show.\n";
	assert.equal(vttToTranscript(vtt), "Hello & welcome to the show.");
});

test("webhook signature", async () => {
	const body = JSON.stringify({ uid: UID, readyToStream: true });
	const time = 1_700_000_000;
	const sig = await hmacHex("s3cret", `${time}.${body}`);
	assert.equal(await verifyWebhookSignature(`time=${time},sig1=${sig}`, body, "s3cret", time + 5), true);
	assert.equal(await verifyWebhookSignature(`time=${time},sig1=${sig}`, `${body} `, "s3cret", time), false);
	assert.equal(await verifyWebhookSignature(`time=${time},sig1=${sig}`, body, "other", time), false);
	assert.equal(await verifyWebhookSignature(`time=${time},sig1=${sig}`, body, "s3cret", time + 601), false, "stale");
	assert.equal(await verifyWebhookSignature(null, body, "s3cret", time), false);
	assert.equal(await verifyWebhookSignature("garbage", body, "s3cret", time), false);
});

test("indexSource prefers the live row and never trusts draft-hydrated events", () => {
	const draftEvent = { id: "e1", status: "published", draftRevisionId: "r2", data: { content: [{ _type: "coywolf-video", uid: UID2 }] } };
	const live = { id: "e1", status: "published", data: { content: [{ _type: "coywolf-video", uid: UID }] } };
	assert.equal(indexSource(draftEvent, live), live);
	assert.deepEqual(findVideoBlocks(indexSource(draftEvent, live).data).map((r) => r.uid), [UID]);
	assert.equal(indexSource(draftEvent, null), null, "draft data without a live row isn't indexed");
	const plain = { id: "e2", status: "published", data: {} };
	assert.equal(indexSource(plain, null), plain);
	assert.equal(indexSource({ id: "e3" }, null), null);
});

test("relative poster images resolve against the site origin", () => {
	assert.equal(isImageUrl("/_emdash/api/media/file/abc.jpg"), true);
	assert.equal(isImageUrl("//evil.example/x.jpg"), false);
	assert.equal(isImageUrl("javascript:alert(1)"), false);
	assert.equal(absoluteUrl("/_emdash/api/media/file/abc.jpg", "https://example.com"), "https://example.com/_emdash/api/media/file/abc.jpg");
	assert.equal(absoluteUrl("/x.jpg", null), undefined);
	assert.equal(absoluteUrl("https://cdn/x.jpg", null), "https://cdn/x.jpg");
	assert.equal(posterUrl(HOST, UID, { posterImage: "/_emdash/api/media/file/k.jpg" }, {}, 1200, "https://example.com/"), "https://example.com/_emdash/api/media/file/k.jpg");
	assert.equal(posterUrl(HOST, UID, {}, { posterImage: "/m/k.jpg" }, 1200, "https://example.com"), "https://example.com/m/k.jpg");
	assert.ok(posterUrl(HOST, UID, { posterImage: "/m/k.jpg" }).includes("/thumbnails/"), "no origin → fall back to a Stream frame");
	const schema = buildVideoObject({ ref: { uid: UID, posterImage: "/m/k.jpg" }, host: HOST, siteUrl: "https://example.com", page: {} });
	assert.deepEqual(schema.thumbnailUrl, ["https://example.com/m/k.jpg"]);
	const refs = findVideoBlocks([{ _type: "coywolf-video", uid: UID, posterImage: "/m/k.jpg" }, { _type: "coywolf-video", uid: UID2, posterImage: "//evil/x.jpg" }]);
	assert.equal(refs[0].posterImage, "/m/k.jpg");
	assert.equal(refs[1].posterImage, undefined);
});

test("RecentKeys is a bounded LRU with a time window", () => {
	const r = new RecentKeys(3, 1000);
	assert.equal(r.seen("a", 0), false);
	assert.equal(r.seen("a", 500), true);
	assert.equal(r.seen("a", 2000), false, "outside the window");
	r.seen("b", 2000);
	r.seen("c", 2000);
	r.seen("d", 2000);
	assert.equal(r.size, 3);
	assert.equal(r.seen("a", 2100), false, "oldest key was evicted");
});

test("caption size cap", () => {
	assert.equal(MAX_CAPTION_BYTES, 1_500_000);
	assert.equal(utf8Bytes("é"), 2);
});

test("light embed poster: Stream thumbnails in three widths; an explicit image as it is", async () => {
	const { posterImage } = await import("../src/videos/lib.ts");
	const uid = "0123456789abcdef0123456789abcdef";
	const p = posterImage("customer-abc.cloudflarestream.com", uid, { posterTime: 3 });
	assert.match(p.src, /width=800/);
	assert.deepEqual(p.srcset.split(", ").map((c) => c.split(" ")[1]), ["400w", "800w", "1200w"]);
	assert.ok(p.srcset.split(", ").every((c) => c.includes("time=3s")));
	const own = posterImage("customer-abc.cloudflarestream.com", uid, { posterImage: "https://example.com/poster.jpg" });
	assert.deepEqual(own, { src: "https://example.com/poster.jpg" });
});

test("Stream's token: the Cloudflare API token wins over the older Stream token; the older one and CF_STREAM_TOKEN still work alone", async () => {
	await import("./ts-resolve.mjs");
	const { credentials } = await import("../src/videos/store.ts");
	const ACCOUNT = "e".repeat(32);
	const ctx = (settings, fetch) => {
		const kv = new Map();
		return {
			settings: { get: async (k) => settings[k] ?? null },
			kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
			...(fetch ? { http: { fetch } } : {}),
		};
	};
	const saved = { videosAccountId: ACCOUNT };
	assert.deepEqual(await credentials(ctx({ ...saved, cloudflareApiToken: "new-token", videosApiToken: "old-token" }), { CF_STREAM_TOKEN: "env-token" }), { accountId: ACCOUNT, token: "new-token" });
	assert.deepEqual(await credentials(ctx({ ...saved, videosApiToken: "old-token" }), { CLOUDFLARE_API_TOKEN: "shared-env" }), { accountId: ACCOUNT, token: "old-token" });
	assert.deepEqual(await credentials(ctx(saved), { CF_STREAM_TOKEN: "env-token", CLOUDFLARE_API_TOKEN: "shared-env" }), { accountId: ACCOUNT, token: "env-token" });
	assert.equal(await credentials(ctx(saved), {}), null, "no token, no Stream");
	// No account saved: CF_ACCOUNT_ID, else the token's only account.
	assert.deepEqual(await credentials(ctx({ cloudflareApiToken: "new-token" }), { CF_ACCOUNT_ID: ACCOUNT }), { accountId: ACCOUNT, token: "new-token" });
	const lookup = async (url) => (assert.match(url, /\/accounts\?per_page=5$/), Response.json({ success: true, result: [{ id: "f".repeat(32) }] }));
	assert.deepEqual(await credentials(ctx({ cloudflareApiToken: "new-token-2" }, lookup), {}), { accountId: "f".repeat(32), token: "new-token-2" });
});

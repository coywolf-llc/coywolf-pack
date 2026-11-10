// Run: node --test test/video-engagement.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { ENGAGEMENT_LIMITS, EngagementLimiter, hasEngagementHeader, likeAction, likesByKey, staleLikesByKey } = await import("../src/videos/engagement.ts");

test("likes need the X-Coywolf-Video header", () => {
	assert.equal(hasEngagementHeader(new Headers({ "X-Coywolf-Video": "1" })), true);
	assert.equal(hasEngagementHeader(new Headers()), false);
	assert.equal(hasEngagementHeader(new Headers({ "X-Coywolf-Video": "yes" })), false);
});

test("plays and likes are rate limited per address per minute", () => {
	const limiter = new EngagementLimiter();
	const now = Date.UTC(2026, 9, 5, 12, 0, 0);
	for (let i = 0; i < ENGAGEMENT_LIMITS.playsPerMinute; i++) assert.ok(limiter.play("a", now));
	assert.equal(limiter.play("a", now), false);
	assert.ok(limiter.play("b", now), "other addresses aren't affected");
	assert.ok(limiter.play("a", now + 60_000), "a new minute");
	for (let i = 0; i < ENGAGEMENT_LIMITS.likesPerMinute; i++) assert.ok(limiter.like("a", now));
	assert.equal(limiter.like("a", now), false);
});

test("new likes are capped per address per day", () => {
	const limiter = new EngagementLimiter();
	const now = Date.UTC(2026, 9, 5, 1, 0, 0);
	for (let i = 0; i < ENGAGEMENT_LIMITS.likesPerDay; i++) assert.ok(limiter.newLike("a", now + i * 60_000));
	assert.equal(limiter.newLike("a", now + 12 * 3_600_000), false);
	assert.ok(limiter.newLike("a", Date.UTC(2026, 9, 6, 0, 0, 1)), "the next (UTC) day");
});

test("a like request with the wanted state doesn't undo someone else's like", () => {
	assert.equal(likeAction(true, true), "keep");
	assert.equal(likeAction(true, false), "add");
	assert.equal(likeAction(false, true), "remove");
	assert.equal(likeAction(false, false), "keep");
	assert.equal(likeAction(undefined, true), "remove", "toggles without a state");
	assert.equal(likeAction(undefined, false), "add");
});

test("daily like counts are pruned by day", () => {
	const key = likesByKey("2026-10-01", "abc");
	assert.equal(staleLikesByKey(key, "2026-10-03"), true);
	assert.equal(staleLikesByKey(likesByKey("2026-10-03", "abc"), "2026-10-03"), false);
	assert.equal(staleLikesByKey("state:videos:likesBy:junk", "2026-10-03"), false);
});

// ── Routes: requests without an address ──────────────────────────

/** A plugin context for the public play/like routes: one published video, engagement on. */
function engagementCtx(ip, writes) {
	const UID = "a67dcf0925d0747f8c5419df6400c2b5";
	const fail = (what) => async () => {
		writes.push(what);
		throw new Error(`unexpected ${what}`);
	};
	const collection = (overrides = {}) => ({
		get: async () => null,
		exists: async () => false,
		query: async () => ({ items: [], hasMore: false }),
		updateIf: fail("updateIf"),
		compareAndSet: fail("compareAndSet"),
		delete: fail("delete"),
		...overrides,
	});
	return {
		input: { uid: UID, liked: true },
		request: new Request("https://example.com/", { method: "POST", headers: { "X-Coywolf-Video": "1" } }),
		requestMeta: { ip },
		settings: { get: async (key) => (key === "features" ? { videos: true, "videos.engagement": true } : null) },
		kv: { get: async () => null, set: fail("kv.set"), getVersioned: async () => null, compareAndSet: async () => ({ applied: true }), delete: async () => undefined },
		storage: {
			videosEmbeds: collection({ query: async () => ({ items: [{ id: "posts:1", data: { status: "published", uids: [UID] } }], hasMore: false }) }),
			videosStats: collection({ get: async () => ({ plays: 7, likes: 3 }) }),
			videosLikes: collection(),
		},
		log: { info() {}, warn() {}, error() {} },
	};
}

test("without a visitor address (no cf object), plays and likes aren't counted as one shared visitor", async () => {
	const { invalidateFeatures } = await import("../src/core/features.ts");
	const { videosPack } = await import("../src/videos/pack.ts"); // Registers the videos switches.
	const { routes } = videosPack({});
	for (const ip of [null, "", "  "]) {
		invalidateFeatures();
		const writes = [];
		const ctx = engagementCtx(ip, writes);
		assert.deepEqual(await routes["videos/play"].handler(ctx), { plays: 7, counted: false });
		assert.deepEqual(await routes["videos/like"].handler(ctx), { likes: 3, liked: false });
		assert.deepEqual(writes, [], "nothing stored");
	}
	invalidateFeatures();
});

test("captions are served only for videos embedded in published content, like the other public video routes", async () => {
	const { invalidateFeatures } = await import("../src/core/features.ts");
	const { videosPack } = await import("../src/videos/pack.ts");
	const { routes } = videosPack({});
	const PUBLISHED = "a67dcf0925d0747f8c5419df6400c2b5";
	const DRAFT_ONLY = "b67dcf0925d0747f8c5419df6400c2b5";
	const ctx = (uid) => ({
		...engagementCtx("203.0.113.9", []),
		input: { uid, lang: "en" },
		settings: { get: async (key) => (key === "features" ? { videos: true, "videos.captions": true } : null) },
		storage: {
			videosEmbeds: {
				query: async () => ({
					items: [
						{ id: "posts:1", data: { status: "published", uids: [PUBLISHED] } },
						{ id: "posts:2", data: { status: "draft", uids: [DRAFT_ONLY] } },
					],
					hasMore: false,
				}),
			},
			videosCaptions: { get: async (id) => ({ uid: id.split(":")[0], language: "en", label: "English", vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nHi" }) },
		},
	});
	invalidateFeatures();
	assert.match((await routes["videos/caption"].handler(ctx(PUBLISHED))).vtt, /^WEBVTT/);
	await assert.rejects(routes["videos/caption"].handler(ctx(DRAFT_ONLY)), /No such caption track/, "a draft's transcript stays private");
	invalidateFeatures();
});

// A site for Buttondown Drafts' tests: the plugin context (storage, settings, content, schema, http to the fake
// Buttondown) and the deps the job uses, with a clock the test moves. `hooks` lets a test make a read fail
// (the post, the collection's fields, the post's terms, the settings).
//
// Import "../ts-resolve.mjs" (or run with --import ./test/ts-resolve.mjs) before this file.
import { FAKE_KEY, fakeButtondown } from "./buttondown-fake.mjs";
import { fakeCollection, fakeKv, fakeSettings, quietLog } from "./fake-plugin.mjs";

const core = await import("../../src/buttondown/sync-core.ts");
const sync = await import("../../src/buttondown/sync.ts");
const { loadSettings } = await import("../../src/buttondown/settings.ts");
const { invalidateFeatures } = await import("../../src/core/features.ts");

export const T0 = Date.parse("2026-11-15T12:00:00Z");
export const SINCE = "2026-11-10T00:00:00.000Z";
export const RULE = { collection: "posts", taxonomy: "category", terms: ["newsletter"], since: SINCE };

const span = (text) => ({ _type: "span", _key: "s", text, marks: [] });
export const para = (text) => ({ _type: "block", _key: "b", style: "normal", markDefs: [], children: [span(text)] });

/** Every fake a test's sites used: after each test, none may have seen a call the Pack must never make. */
export const fakes = new Set();

export function site({ fake = fakeButtondown(), features = {}, settings = {}, storage, handleEvent = sync.handleEvent, settle = sync.settleJobsForTests } = {}) {
	invalidateFeatures();
	fakes.add(fake);
	const entries = new Map();
	const terms = new Map();
	let clock = T0;
	const slept = [];
	/** Set one to a function to replace that read (throw from it to make the read fail). */
	const hooks = { contentGet: null, schemaGet: null, terms: null, settings: null };
	const ctx = {
		storage: { buttondownEmails: storage ?? fakeCollection() },
		kv: fakeKv(),
		log: quietLog(),
		site: { url: "https://coywolf.com", name: "Coywolf" },
		settings: fakeSettings({ features: { _defaults036: true, buttondown: true, "buttondown.updates": true, ...features }, buttondownApiKey: FAKE_KEY, buttondownSettings: { rules: [RULE], footerLink: true }, ...settings }),
		http: fake.http,
		content: { get: async (collection, id) => (hooks.contentGet ? hooks.contentGet(collection, id) : entries.has(id) ? structuredClone(entries.get(id)) : null) },
		schema: {
			getCollection: async (slug) => {
				if (hooks.schemaGet) return hooks.schemaGet(slug);
				return slug === "posts"
					? { slug, label: "Posts", titleField: "title", urlPattern: "/{slug}/", routable: true, hidden: false, fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "featured_image", type: "image", sortOrder: 1 }, { slug: "content", type: "portableText", sortOrder: 2 }, { slug: "excerpt", type: "text", sortOrder: 3 }] }
					: null;
			},
		},
	};
	const deps = {
		now: () => clock,
		db: async () => null,
		// Strict: a settings read that fails throws (as the Worker's does).
		settings: (c) => (hooks.settings ? hooks.settings(c) : loadSettings(c, true)),
		terms: async (_ctx, _collection, id) => (hooks.terms ? hooks.terms(id) : (terms.get(id) ?? [])),
		termParents: async () => new Map([["newsletter-extra", "newsletter"]]),
		postUrl: async (_ctx, _collection, item) => `https://coywolf.com/newsletter/${item.slug}/`,
		files: async () => new Map(),
		background: () => {},
		sleep: async (ms) => void slept.push(ms),
	};
	const post = (id, extra = {}) => {
		const item = { id, slug: `post-${id.toLowerCase()}`, status: "published", publishedAt: "2026-11-15T10:00:00.000Z", draftRevisionId: null, data: { title: `Post ${id}`, excerpt: "Short.", content: [para("Hello.")] }, seo: null, ...extra };
		entries.set(id, item);
		if (!terms.has(id)) terms.set(id, ["newsletter"]);
		return item;
	};
	/** The hook alone (the job is left to run): for a test that needs something to happen while it runs. */
	const fire = (kind, id, extra = {}) => {
		const item = entries.get(id);
		return handleEvent(ctx, deps, kind, kind === "trash" || kind === "delete" ? { id, collection: "posts", permanent: kind === "delete" } : { collection: "posts", content: { ...item, ...extra } });
	};
	const event = async (kind, id, extra = {}) => {
		await fire(kind, id, extra);
		await settle();
	};
	const record = async (id) => core.readRecord(await ctx.storage.buttondownEmails.get(core.recordId("posts", id)));
	return {
		fake,
		ctx,
		deps,
		entries,
		terms,
		hooks,
		slept,
		post,
		fire,
		event,
		record,
		advance: (ms) => (clock += ms),
		now: () => clock,
		unpublish: async (id) => {
			entries.get(id).status = "draft";
			await event("unpublish", id);
		},
		republish: async (id, data = {}) => {
			const item = entries.get(id);
			item.status = "published";
			item.data = { ...item.data, ...data };
			await event("publish", id);
		},
	};
}

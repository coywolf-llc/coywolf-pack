// Stands in for @astrojs/cloudflare's cache provider (dist/cache/provider.js, 14.4.8) in test/cache-provider.test.mjs,
// which the pack doesn't install. invalidate() is the same as the real one: the tags from collectInvalidationTags
// (the real one, from astro), purged with cache.purge from cloudflare:workers, the result not read. setHeaders is a
// stand-in that's recognized by the tests. Calls are recorded on globalThis.__astro.
import { collectInvalidationTags } from "astro/cache/provider-utils";

const record = () => (globalThis.__astro ??= { configs: [], invalidates: [], setHeaders: [] });

export default function factory(config) {
	record().configs.push(config);
	return {
		name: "cloudflare",
		setHeaders(options, request) {
			record().setHeaders.push({ options, url: request.url });
			return new Headers({ "Cache-Tag": "fixture", "Cloudflare-CDN-Cache-Control": "public, max-age=60" });
		},
		async invalidate(options) {
			record().invalidates.push(options);
			const { cache } = await import("cloudflare:workers");
			const tags = collectInvalidationTags(options);
			if (tags.length > 0) await cache.purge({ tags });
		},
	};
}

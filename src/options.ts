import type { AiOptions } from "./ai/store.js";
import type { BackupsOptions } from "./backups/module.js";
import type { HeadingsOptions } from "./headings/pack.js";
import type { BreadcrumbsOptions } from "./breadcrumbs/pack.js";
import type { CodeBlocksOptions } from "./codeBlocks/pack.js";
import type { FilesOptions } from "./files/module.js";
import type { DiscoveryOptions } from "./discovery/module.js";
import type { LinksOptions } from "./links/module.js";
import type { RedirectsOptions } from "./redirects/module.js";
import type { SchemaOptions } from "./schema/module.js";
import type { SearchOptions } from "./search/module.js";
import type { VideosOptions } from "./videos/module.js";
import type { RobotsOptions } from "./robots/module.js";
import type { ReviewsOptions } from "./reviews/pack.js";
import type { TrailingSlash } from "./core/content-url.js";

/**
 * Modules to include in the build. Backups needs its bindings, so it's
 * included only when configured; every other module is included unless set
 * to false. Included modules are then turned on or off on the Coywolf Pack page.
 */
export interface CoywolfOptions {
	backups?: BackupsOptions | false;
	redirects?: RedirectsOptions | false;
	headings?: HeadingsOptions | false;
	breadcrumbs?: BreadcrumbsOptions | false;
	codeBlocks?: CodeBlocksOptions | false;
	schema?: SchemaOptions | false;
	files?: FilesOptions | false;
	/** Private form uploads (no options here; the Forms plugin is wrapped with privateFormUploads()). `false` leaves the module out. */
	formUploads?: Record<string, never> | false;
	search?: SearchOptions | false;
	ai?: AiOptions | false;
	discovery?: DiscoveryOptions | false;
	links?: LinksOptions | false;
	videos?: VideosOptions | false;
	robots?: RobotsOptions | false;
	reviews?: ReviewsOptions | false;
	/** Custom Blocks: Note, Details, Affiliate disclosure, Quote, Testimonial and Podcast links blocks (no options yet). `false` leaves the module out. */
	customBlocks?: Record<string, never> | false;
	/** Clean Image URLs on the media host: its address comes from EmDash's r2({ publicUrl }) (`cdn` is deprecated since 0.38.0), the media bucket and Images binding names, crops. */
	images?: import("./images/pack.js").ImagesOptions | false;
	/** Page cache upkeep for Cloudflare Workers Cache (see docs/performance.md). `false` leaves the module out. */
	pageCache?: import("./pageCache/pack.js").PageCacheOptions | false;
	/** Speculation Rules: prefetch (and optionally prerender) the next page (settings on the Performance page; no options here). `false` leaves the module out. */
	speculation?: Record<string, never> | false;
	/** Cloudflare Checkup: the zone settings that matter, with one-click fixes (no options here). `false` leaves the module out. */
	cloudflare?: Record<string, never> | false;
	/** Insights reports (edge errors, Core Web Vitals, Fathom, Search Console, search insights). `false` leaves the module out. */
	insights?: import("./insights/pack.js").InsightsOptions | false;
	/** The daily check for a newer Coywolf Pack on npm (off until turned on on the Features page). `false` leaves the module out. */
	updates?: Record<string, never> | false;
	/** @deprecated Until 0.12.0 the Custom Blocks module was called Content Blocks; `contentBlocks: false` still leaves it out. */
	contentBlocks?: Record<string, never> | false;
	/** WordPress import tools (no options yet). `false` leaves the module out. */
	wpImport?: Record<string, never> | false;
	/** Content Audit (no options; settings are on its page). `false` leaves the module out. */
	audit?: Record<string, never> | false;
	/** Alerts & Digest (no options; settings are on its page). `false` leaves the module out. */
	alerts?: Record<string, never> | false;
	/** Social Images: the media bucket's binding (default "MEDIA"). `false` leaves the module out. */
	socialImages?: import("./social/pack.js").SocialImagesOptions | false;
	/**
	 * Entry URL patterns for collections the theme routes differently from
	 * EmDash's url_pattern, e.g. `{ posts: "/{term:category|uncategorized}/{slug}/" }`
	 * or, with parent categories in the path, `{ posts: "/{termpath:category|uncategorized}/{slug}/" }`.
	 * Used by every module that builds entry URLs (see docs/content-urls.md).
	 */
	urls?: Record<string, string>;
	/** Trailing-slash policy for entry URLs. Default: EmDash's (Astro's `trailingSlash`). */
	trailingSlash?: TrailingSlash;
	/**
	 * Parent terms for `{termpath:<taxonomy>}` URLs, taxonomy → term slug →
	 * parent slug, e.g. `{ category: { seo: "news" } }`. Used only for terms
	 * that have no parent in EmDash.
	 */
	termParents?: Record<string, Record<string, string>>;
	/** Parent pages for `{pagepath}` URLs, slug → parent slug, e.g. `{ "coywolf-seo": "apps" }`. EmDash entries have no parent of their own. */
	pageParents?: Record<string, string>;
}

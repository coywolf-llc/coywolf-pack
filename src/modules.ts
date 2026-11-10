/**
 * The module list. Order matters: hooks and middleware run in this order.
 * To add a module: import its factory and middleware, then add one entry to
 * MODULES (and MIDDLEWARE if it serves site URLs).
 */
import { aiPack } from "./ai/pack.js";
import { backupsDownloadMiddleware, backupsPack } from "./backups/pack.js";
import { cloudflarePack } from "./cloudflare/pack.js";
import { codeBlocksPack } from "./codeBlocks/pack.js";
import { customBlocksPack } from "./customBlocks/pack.js";
import type { PackMiddleware, PackModule } from "./core/module.js";
import { headingsPack } from "./headings/pack.js";
import { imagesMiddleware, imagesPack } from "./images/pack.js";
import { pageCacheMiddleware, strayRobotsMiddleware, pageCachePack } from "./pageCache/pack.js";
import { breadcrumbsPack } from "./breadcrumbs/pack.js";
import { filesMiddleware, filesPack } from "./files/pack.js";
import { formUploadsPack } from "./formUploads/pack.js";
import { discoveryMiddleware, discoveryPack } from "./discovery/pack.js";
import { linksPack } from "./links/pack.js";
import { redirectsMiddleware, redirectsPack } from "./redirects/pack.js";
import { schemaPack } from "./schema/pack.js";
import { searchLiveMiddleware, searchPack, searchRateLimitMiddleware } from "./search/pack.js";
import { robotsMiddleware, robotsPack } from "./robots/pack.js";
import { reviewsPack } from "./reviews/pack.js";
import { speculationPack } from "./speculation/pack.js";
import type { CoywolfOptions } from "./options.js";
import { videosCaptionsMiddleware, videosPack, videosSitemapMiddleware } from "./videos/pack.js";
import { updatesPack } from "./updates/pack.js";
import { wpImportPack } from "./wpImport/pack.js";

type Factory = (options: CoywolfOptions) => PackModule | null;

export const MODULES: Factory[] = [
	// First on the Features page, where it's easy to find (no hooks or middleware, so its place changes nothing else).
	(o) => (o.updates === false ? null : updatesPack()),
	(o) => (o.backups ? backupsPack(o.backups) : null),
	(o) => (o.redirects === false ? null : redirectsPack(o.redirects ?? {})),
	// Before Headings & TOC: imported heading ids must be in place when anchors are stamped.
	(o) => (o.wpImport === false ? null : wpImportPack()),
	(o) => (o.headings === false ? null : headingsPack(o.headings ?? {})),
	(o) => (o.breadcrumbs === false ? null : breadcrumbsPack(o.breadcrumbs ?? {})),
	(o) => (o.codeBlocks === false ? null : codeBlocksPack(o.codeBlocks ?? {})),
	(o) => (o.schema === false ? null : schemaPack(o.schema ?? {})),
	(o) => (o.files === false ? null : filesPack(o.files ?? {})),
	(o) => (o.formUploads === false ? null : formUploadsPack()),
	(o) => (o.search === false ? null : searchPack(o.search ?? {})),
	(o) => (o.ai === false ? null : aiPack(o.ai ?? {})),
	(o) => (o.discovery === false ? null : discoveryPack(o.discovery ?? {})),
	(o) => (o.links === false ? null : linksPack()),
	(o) => (o.videos === false ? null : videosPack(o.videos ?? {})),
	(o) => (o.robots === false ? null : robotsPack(o.robots ?? {})),
	(o) => (o.reviews === false ? null : reviewsPack(o.reviews ?? {})),
	(o) => (o.customBlocks === false || o.contentBlocks === false ? null : customBlocksPack()),
	(o) => (o.images === false ? null : imagesPack(o.images ?? {})),
	(o) => (o.pageCache === false ? null : pageCachePack(o.pageCache ?? {})),
	(o) => (o.speculation === false ? null : speculationPack()),
	(o) => (o.cloudflare === false ? null : cloudflarePack()),
];

export const MIDDLEWARE: PackMiddleware[] = [pageCacheMiddleware, strayRobotsMiddleware, imagesMiddleware, backupsDownloadMiddleware, redirectsMiddleware, robotsMiddleware, filesMiddleware, searchLiveMiddleware, searchRateLimitMiddleware, ...discoveryMiddleware, videosSitemapMiddleware, videosCaptionsMiddleware];

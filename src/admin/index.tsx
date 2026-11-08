import type { PluginAdminExports } from "emdash";

import { injectAdminCss } from "./admin-css.js";
import { mountTrashPrompt } from "./trash-prompt.js";
import { withUpdateLine, withUpdateNotice } from "./update-notice.js";

import { AiPage } from "./ai.js";
import { BackupStatusWidget, BackupsPage } from "./backups.js";
import { CodeBlocksPage } from "./codeBlocks.js";
import { CustomBlocksPage } from "./customBlocks.js";
import { DiscoveryPage } from "./discovery.js";
import { FeaturesPage } from "./features.js";
import { HeadingsPage } from "./headings.js";
import { ImagesPage } from "./images.js";
import { PerformancePage } from "./performance.js";
import { UsageWidget } from "./usage.js";
import { BreadcrumbsPage } from "./breadcrumbs.js";
import { FilesPage } from "./files.js";
import { FormUploadsPage } from "./formUploads.js";
import { LinksPage, LinksWidget } from "./links.js";
import { RedirectsPage } from "./redirects.js";
import { SchemaPage } from "./schema.js";
import { SearchPage } from "./search.js";
import { VideosPage } from "./videos.js";
import { RobotsPage } from "./robots.js";
import { WpImportPage } from "./wpImport.js";
import { ReviewsPage } from "./reviews.js";

// Rules for the layout classes EmDash's admin stylesheet lacks (see admin-css.ts).
injectAdminCss();
// Asks what a trashed or unpublished entry's old URL should do (Redirects → Removed content).
mountTrashPrompt();

const PAGES: PluginAdminExports["pages"] = {
	"/features": FeaturesPage,
	"/performance": PerformancePage,
	"/backups": BackupsPage,
	"/redirects": RedirectsPage,
	"/headings": HeadingsPage,
	"/breadcrumbs": BreadcrumbsPage,
	"/code-blocks": CodeBlocksPage,
	"/schema": SchemaPage,
	"/files": FilesPage,
	"/form-uploads": FormUploadsPage,
	"/search": SearchPage,
	"/ai": AiPage,
	"/discovery": DiscoveryPage,
	"/links": LinksPage,
	"/videos": VideosPage,
	"/robots": RobotsPage,
	"/reviews": ReviewsPage,
	"/custom-blocks": CustomBlocksPage,
	// Called Content Blocks until 0.12.0: old bookmarks still open the page.
	"/content-blocks": CustomBlocksPage,
	"/wordpress-import": WpImportPage,
	"/images": ImagesPage,
};

// Every pack page shows the update notice at the top when a newer Coywolf Pack is out.
export const pages: PluginAdminExports["pages"] = Object.fromEntries(Object.entries(PAGES).map(([path, Page]) => [path, withUpdateNotice(Page)]));

export const widgets: PluginAdminExports["widgets"] = {
	"backup-status": BackupStatusWidget,
	"links-status": LinksWidget,
	// Always on the dashboard (unless the pageCache module is left out), so it carries the update line.
	"cloudflare-usage": withUpdateLine(UsageWidget),
};

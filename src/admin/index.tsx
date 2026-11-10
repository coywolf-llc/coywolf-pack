import type { PluginAdminExports } from "emdash";

import { injectAdminCss } from "./admin-css.js";
import { packPage } from "./page.js";
import { mountTrashPrompt } from "./trash-prompt.js";
import { UpdateWidget } from "./update-notice.js";

import { BackupStatusWidget } from "./backups-widget.js";
import { LinksWidget } from "./links-widget.js";
import { UsageWidget } from "./usage.js";

// Rules for the layout classes EmDash's admin stylesheet lacks (see admin-css.ts).
injectAdminCss();
// Asks what a trashed or unpublished entry's old URL should do (Redirect Manager → Removed content).
mountTrashPrompt();

/**
 * Every pack page, loaded the first time it's opened: each is its own chunk,
 * so an admin visit downloads only the pages it opens. The dashboard widgets
 * and the trash prompt above stay in this entry. Each page also gets the
 * update notice, an error boundary and toasts (packPage in page.tsx).
 */
const PAGES: Record<string, ReturnType<typeof packPage>> = {
	"/features": packPage("Features", () => import("./features.js").then((m) => m.FeaturesPage)),
	"/performance": packPage("Performance", () => import("./performance.js").then((m) => m.PerformancePage)),
	"/backups": packPage("Backups", () => import("./backups.js").then((m) => m.BackupsPage)),
	"/redirects": packPage("Redirect Manager", () => import("./redirects.js").then((m) => m.RedirectsPage)),
	"/headings": packPage("Headings & TOC", () => import("./headings.js").then((m) => m.HeadingsPage)),
	"/breadcrumbs": packPage("Breadcrumb Nav", () => import("./breadcrumbs.js").then((m) => m.BreadcrumbsPage)),
	"/code-blocks": packPage("Code Blocks", () => import("./codeBlocks.js").then((m) => m.CodeBlocksPage)),
	"/schema": packPage("Schema & Social", () => import("./schema.js").then((m) => m.SchemaPage)),
	"/files": packPage("File Downloads", () => import("./files.js").then((m) => m.FilesPage)),
	"/form-uploads": packPage("Private Form Uploads", () => import("./formUploads.js").then((m) => m.FormUploadsPage)),
	"/search": packPage("Search", () => import("./search.js").then((m) => m.SearchPage)),
	"/ai": packPage("AI Enrichment", () => import("./ai.js").then((m) => m.AiPage)),
	"/discovery": packPage("Discovery", () => import("./discovery.js").then((m) => m.DiscoveryPage)),
	"/links": packPage("Link Manager", () => import("./links.js").then((m) => m.LinksPage)),
	"/videos": packPage("Videos", () => import("./videos.js").then((m) => m.VideosPage)),
	"/robots": packPage("Robots.txt", () => import("./robots.js").then((m) => m.RobotsPage)),
	"/reviews": packPage("Reviews", () => import("./reviews.js").then((m) => m.ReviewsPage)),
	"/custom-blocks": packPage("Custom Blocks", () => import("./customBlocks.js").then((m) => m.CustomBlocksPage)),
	"/wordpress-import": packPage("WordPress Migration", () => import("./wpImport.js").then((m) => m.WpImportPage)),
	"/images": packPage("Clean Image URLs", () => import("./images.js").then((m) => m.ImagesPage)),
};

// Called Content Blocks until 0.12.0: old bookmarks still open the page.
PAGES["/content-blocks"] = PAGES["/custom-blocks"] as ReturnType<typeof packPage>;

export const pages: PluginAdminExports["pages"] = PAGES;

export const widgets: PluginAdminExports["widgets"] = {
	"backup-status": BackupStatusWidget,
	"links-status": LinksWidget,
	"cloudflare-usage": UsageWidget,
	// Listed by the server only while a Coywolf Pack update is waiting.
	update: UpdateWidget,
};

/**
 * EmDash 1.4+: the pack's sections in the entry editor sidebar (Schema & Social, AI suggestions,
 * Link status) and its Links column in content lists, each only while its module is on
 * (src/admin/editor-panels.tsx, src/admin/extensions.ts).
 */
export { contentEditorPanels, contentListColumns } from "./editor-panels.js";

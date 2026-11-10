/**
 * The pack's admin sidebar: which folder each page goes in, and in what order.
 *
 * EmDash (1.2.0+) folds the pages that share a `group` into one folder in
 * the Plugins section, placed where the group first appears, with the
 * folder's icon taken from its first page that has one. A page whose group
 * matches a collection's sidebar group joins that content folder instead
 * (EmDash 1.4), so the names avoid ones a site is likely to give its
 * collections ("Content", "Media").
 *
 * Kept free of imports so tests can load it directly.
 */

export interface SidebarPage {
	path: string;
	label: string;
	icon?: string;
	group?: string;
}

/** The folders, in order, and their pages, in order. A page that isn't listed goes at the end of the first folder. */
export const SIDEBAR_FOLDERS: ReadonlyArray<{ group: string; pages: readonly string[] }> = [
	{ group: "Coywolf Pack", pages: ["/features", "/performance", "/backups", "/alerts", "/wordpress-import"] },
	{ group: "SEO", pages: ["/schema", "/social-images", "/discovery", "/robots", "/redirects", "/links", "/breadcrumbs"] },
	{ group: "Content Tools", pages: ["/content-audit", "/headings", "/code-blocks", "/custom-blocks", "/reviews", "/ai", "/search"] },
	{ group: "Media Tools", pages: ["/images", "/videos", "/files", "/form-uploads"] },
];

/** The pages with their folder, ordered folder by folder (each folder in one piece, the order EmDash shows them in). */
export function sidebarPages<T extends SidebarPage>(pages: T[], folders = SIDEBAR_FOLDERS): T[] {
	const [first, ...others] = folders;
	if (!first) return pages;
	const placedPaths = new Set(folders.flatMap((f) => f.pages));
	const inFolder = (folder: { group: string; pages: readonly string[] }) =>
		folder.pages.flatMap((path) => pages.filter((p) => p.path === path)).map((p) => ({ ...p, group: folder.group }));
	const unlisted = pages.filter((p) => !placedPaths.has(p.path)).map((p) => ({ ...p, group: first.group }));
	return [...inFolder(first), ...unlisted, ...others.flatMap(inFolder)];
}

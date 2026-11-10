import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { type SchemaOptions, schemaMetadataHook, schemaModule, schemaStorage } from "./module.js";

const FEATURES = [
	{
		id: "schema",
		label: "Schema & Social",
		description: "Schema.org structured data, robots directives, and Open Graph extras, configured on the Schema page.",
		default: false,
	},
	{
		id: "schema.graph",
		label: "Schema.org graph",
		description:
			"One JSON-LD @graph per page (WebSite, publisher, typed WebPage and Article, authors, image) in place of EmDash's built-in JSON-LD.",
		default: false,
	},
	{
		id: "schema.breadcrumbs",
		label: "Breadcrumb schema",
		description:
			"A BreadcrumbList from the theme's breadcrumbs, or derived from the URL. Remove any BreadcrumbList your theme prints itself.",
		default: false,
	},
	{
		id: "schema.robots",
		label: "Robots directives",
		description: "A robots meta tag with max-image-preview, max-snippet and max-video-preview, merged with each entry's No index.",
		default: false,
	},
	{
		id: "schema.openGraph",
		label: "Open Graph extras",
		description: "og:locale, plus og:image width, height, type and alt (from the media library) and twitter:image:alt.",
		default: false,
	},
	{
		id: "schema.authors",
		label: "Author profiles",
		description: "Schema.org Person properties per byline (job title, sameAs profiles, image…) used as article authors.",
		default: false,
	},
	{
		id: "schema.custom",
		label: "Custom markup",
		description: "Your own JSON-LD for a page (a path like the home page) or an entry, checked for errors and Google's rich-result rules.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function schemaPack(options: SchemaOptions): PackModule {
	return {
		id: "schema",
		label: "Schema & Social",
		features: FEATURES,
		routes: schemaModule(options).routes,
		hooks: { "page:metadata": schemaMetadataHook(options) },
		adminPages: [{ path: "/schema", label: "Schema & Social", icon: "tree-structure" }],
		storage: schemaStorage,
		capabilities: ["content:read", "schema:read", "bylines:read", "media:read"],
	};
}

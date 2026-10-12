import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";

import { PLUGIN_ID, registerFeatures } from "../core/features.js";
import { noteReadFailure, routeFailed } from "../core/read-failures.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { BLOCK_TYPE } from "./lib.js";
import { F, type VideosOptions, videosModule } from "./module.js";
// Registers the copied-posters setting before the first settings read (see poster.ts).
import "./poster.js";
import { STORAGE } from "./store.js";

export type { VideosOptions } from "./module.js";

const FEATURES = [
	{ id: F.main, label: "Videos", description: "Cloudflare Stream library, uploads, and the Coywolf Video block.", default: false },
	{ id: F.schema, label: "Video schema", description: "VideoObject structured data for every embedded video.", default: false },
	{ id: F.sitemap, label: "Video sitemap", description: "A Google video sitemap at /coywolf-video-sitemap.xml.", default: false },
	{ id: F.engagement, label: "Plays and likes", description: "Count plays and show a like button under videos.", default: false },
	{ id: F.captions, label: "Captions", description: "Upload or generate captions, and add them (with a transcript) to schema.", default: false },
	{ id: F.webhook, label: "Stream webhook", description: "Refresh video details as soon as Stream finishes processing.", default: false },
];
registerFeatures(FEATURES);

const toggle = (action_id: string, label: string, initial_value: boolean) => ({ type: "toggle", action_id, label, initial_value });

/** Left/center/right, with the site default (Videos → Settings → Appearance) as the empty choice. */
const alignSelect = (action_id: string, label: string) => ({
	type: "select",
	action_id,
	label,
	options: [
		{ value: "", label: "Site default" },
		{ value: "left", label: "Left" },
		{ value: "center", label: "Center" },
		{ value: "right", label: "Right" },
	],
});

/**
 * Show/hide with the site default (Videos → Settings) as the empty choice, so
 * new blocks follow the settings. No initial value: a block only keeps a
 * choice someone made. Older blocks may hold true/false (see lib.ts resolveShow).
 */
const showSelect = (action_id: string, label: string) => ({
	type: "select",
	action_id,
	label,
	options: [
		{ value: "", label: "Site default" },
		{ value: "show", label: "Show" },
		{ value: "hide", label: "Hide" },
	],
});

export function videosPack(options: VideosOptions): PackModule {
	const videos = videosModule(options);
	return {
		id: "videos",
		label: "Videos",
		features: FEATURES,
		routes: videos.routes,
		hooks: videos.hooks,
		hookFeature: { "page:metadata": F.schema },
		tasks: videos.tasks,
		adminPages: [{ path: "/videos", label: "Videos", icon: "video" }],
		storage: STORAGE,
		capabilities: ["content:read", "schema:read"],
		portableTextBlocks: [
			{
				type: BLOCK_TYPE,
				label: "Coywolf Video",
				icon: "video",
				category: "Media",
				description: "A Cloudflare Stream video with schema, captions, plays and likes",
				fields: [
					{ type: "select", action_id: "uid", label: "Video", options: [], optionsRoute: "videos/options" },
					{
						type: "select",
						action_id: "preset",
						label: "Style",
						options: [
							{ value: "standard", label: "Standard player" },
							{ value: "gif", label: "Loop like a GIF (muted, autoplay, no controls)" },
						],
						initial_value: "standard",
					},
					{ type: "text_input", action_id: "title", label: "Title (defaults to the video's name)" },
					{ type: "text_input", action_id: "caption", label: "Description", multiline: true },
					{ type: "number_input", action_id: "posterTime", label: "Poster frame (seconds into the video)", min: 0 },
					{ type: "media_picker", action_id: "posterImage", label: "Poster image (overrides the frame)", mime_type_filter: "image/" },
					{ type: "number_input", action_id: "startTime", label: "Start at (seconds)", min: 0 },
					toggle("controls", "Show controls", true),
					toggle("autoplay", "Autoplay (muted)", false),
					toggle("loop", "Loop", false),
					toggle("muted", "Muted", false),
					{
						type: "select",
						action_id: "preload",
						label: "Preload",
						options: [
							{ value: "metadata", label: "Metadata" },
							{ value: "none", label: "None" },
							{ value: "auto", label: "Auto" },
						],
						initial_value: "metadata",
					},
					{
						type: "select",
						action_id: "sizeMode",
						label: "Size",
						options: [
							{ value: "responsive", label: "Full width" },
							{ value: "maxwidth", label: "Maximum width" },
						],
						initial_value: "responsive",
					},
					{ type: "number_input", action_id: "maxWidth", label: "Maximum width (px)", min: 100, max: 4000 },
					showSelect("showName", "Video name below the video"),
					showSelect("showDescription", "Description below the video"),
					showSelect("showPlays", "Number of views"),
					showSelect("showLikes", "Like button"),
					showSelect("showLikeCount", "Number of likes"),
					showSelect("showDate", "Upload date"),
					alignSelect("contentAlign", "Name & description alignment"),
					alignSelect("metaAlign", "Like / views / date row alignment"),
					{ type: "number_input", action_id: "radius", label: "Corner radius (px; empty uses the site default)", min: 0, max: 48 },
					showSelect("showBorder", "Border around the player"),
					{ type: "number_input", action_id: "borderWidth", label: "Border width (px; empty uses the site default)", min: 0, max: 20 },
					{ type: "text_input", action_id: "borderColor", label: "Border color (hex; empty uses the site default)", placeholder: "#eeeeee" },
				],
			},
		],
	};
}

// ── Site URLs ────────────────────────────────────────────────────

type Locals = Parameters<typeof getPublicPluginApiRouteHandler>[0];

async function callPublic(locals: unknown, origin: string, route: string, body: unknown): Promise<unknown> {
	const handler = getPublicPluginApiRouteHandler(locals as Locals);
	if (!handler) return null;
	const request = new Request(new URL(`/_emdash/api/plugins/${PLUGIN_ID}/${route}`, origin), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const res = (await handler(PLUGIN_ID, "POST", `/${route}`, request)) as { success?: boolean; data?: unknown; status?: number; error?: { code?: string } };
	// A server error: whatever answers the URL instead (the site's own route) isn't edge-cached.
	if (routeFailed(res)) noteReadFailure(route);
	return res?.success ? res.data : null;
}

const SITEMAP_PATH = "/coywolf-video-sitemap.xml";
let sitemapMemo: { xml: string; at: number } | null = null;

export const videosSitemapMiddleware: PackMiddleware = {
	module: "videos",
	feature: F.sitemap,
	handle: async (context) => {
		if (context.url.pathname !== SITEMAP_PATH) return undefined;
		if (!sitemapMemo || Date.now() - sitemapMemo.at > 5 * 60_000) {
			const data = (await callPublic(context.locals, context.url.origin, "videos/sitemap", {})) as { xml?: string } | null;
			if (!data?.xml) return undefined;
			sitemapMemo = { xml: data.xml, at: Date.now() };
		}
		return new Response(context.request.method === "HEAD" ? null : sitemapMemo.xml, {
			headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=900" },
		});
	},
};

const CAPTION_PATH = /^\/coywolf-video-captions\/([0-9a-f]{32})\/([A-Za-z0-9-]{2,24})\.vtt$/;

export const videosCaptionsMiddleware: PackMiddleware = {
	module: "videos",
	feature: F.captions,
	handle: async (context) => {
		const m = context.url.pathname.match(CAPTION_PATH);
		if (!m) return undefined;
		const data = (await callPublic(context.locals, context.url.origin, "videos/caption", { uid: m[1], lang: m[2] })) as { vtt?: string } | null;
		if (!data?.vtt) return new Response("Not found", { status: 404 });
		return new Response(data.vtt, {
			headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
		});
	},
};

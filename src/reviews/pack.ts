/**
 * Reviews module: the Coywolf Review block (rating badge, pros and cons),
 * its style settings (accent color, custom CSS) on the Reviews admin page,
 * and Review schema, folded into Schema & Social's graph or printed on its
 * own. Rendered by src/astro/reviews/CoywolfReview.astro.
 */
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { parseInput } from "../shared.js";
import {
	BLOCK_TYPE,
	DEFAULT_ACCENT,
	DEFAULT_CONS_HEADING,
	DEFAULT_PROS_HEADING,
	ITEM_TYPES,
	MAX_CUSTOM_CSS,
	RATING_OPTIONS,
	STYLE_SETTING,
	isAccent,
	normalizeReviewRatings,
	normalizeStyle,
	sanitizeCustomCss,
} from "./lib.js";
import { reviewsMetadata } from "./schema.js";
import { invalidateReviewStyle } from "./settings.js";

// An empty interface: reserved for future options.
export interface ReviewsOptions {}

export const F = { main: "reviews", schema: "reviews.schema" } as const;

export const FEATURES = [
	{ id: F.main, label: "Reviews", description: "The Coywolf Review block: a rating badge with what you liked and what could be better.", default: false },
	{
		id: F.schema,
		label: "Review schema",
		description: "Review structured data (rating, pros and cons) for each review, in Schema & Social's graph or on its own.",
		default: false,
	},
];
registerFeatures(FEATURES);

/** Store ratings as the menu's values ("4" → "4.0"), so older reviews show their rating in the editor. */
async function beforeSave(event: { content: Record<string, unknown> }) {
	if (!event.content || !JSON.stringify(event.content).includes(`"${BLOCK_TYPE}"`)) return undefined;
	return normalizeReviewRatings(event.content) ?? undefined;
}

export function reviewsPack(_options: ReviewsOptions): PackModule {
	return {
		id: "reviews",
		label: "Reviews",
		features: FEATURES,
		hooks: { "page:metadata": reviewsMetadata, "content:beforeSave": beforeSave },
		hookFeature: { "page:metadata": F.schema },
		adminPages: [{ path: "/reviews", label: "Reviews", icon: "star" }],
		capabilities: ["content:read"],
		routes: {
			"reviews/settings": {
				permission: "plugins:manage" as const,
				// any: plugin context.
				handler: async (ctx: any) => ({ ...normalizeStyle(await ctx.settings.get(STYLE_SETTING)), defaultAccent: DEFAULT_ACCENT }),
			},

			"reviews/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const input = parseInput(
						z.object({
							accent: z.string().max(9).refine(isAccent, "Use a hex color like #2C8452."),
							css: z.string().max(MAX_CUSTOM_CSS, `Custom CSS is limited to ${MAX_CUSTOM_CSS / 1000} KB.`),
						}),
						ctx.input,
					);
					const style = { accent: input.accent, css: sanitizeCustomCss(input.css) };
					await ctx.settings.set(STYLE_SETTING, style);
					invalidateReviewStyle();
					ctx.log.info("Review style saved", { accent: style.accent, cssBytes: style.css.length });
					return style;
				},
			}),
		},
		portableTextBlocks: [
			{
				type: BLOCK_TYPE,
				label: "Coywolf Review",
				icon: "star",
				category: "Content",
				description: "A rating badge with pros and cons, and Review schema",
				fields: [
					{ type: "text_input", action_id: "itemName", label: "Item name (what you're reviewing)" },
					{
						type: "select",
						action_id: "itemType",
						label: "Item type",
						options: ITEM_TYPES.map(([value, label]) => ({ value, label })),
						initial_value: "Product",
					},
					{ type: "text_input", action_id: "brand", label: "Brand (optional)" },
					{ type: "text_input", action_id: "itemUrl", label: "Item URL (optional, https://…)" },
					{ type: "media_picker", action_id: "image", label: "Item image (optional, for schema)", mime_type_filter: "image/" },
					{ type: "text_input", action_id: "bookAuthor", label: "Book author (books only, for schema)" },
					{ type: "text_input", action_id: "isbn", label: "ISBN (books only, for schema)" },
					{ type: "text_input", action_id: "bookPublisher", label: "Publisher (books only, for schema)" },
					{ type: "text_input", action_id: "genre", label: "Genre (books only, for schema)" },
					{ type: "text_input", action_id: "copyrightYear", label: "Copyright year (books only, for schema)" },
					{ type: "text_input", action_id: "operatingSystem", label: "Operating systems (software only, e.g. macOS, Windows)" },
					{ type: "text_input", action_id: "applicationCategory", label: "App category (software only, e.g. Utilities)" },
					{ type: "select", action_id: "rating", label: "Rating (0 to 5, in tenths)", options: RATING_OPTIONS },
					{ type: "text_input", action_id: "prosHeading", label: "Pros heading", initial_value: DEFAULT_PROS_HEADING },
					{ type: "text_input", action_id: "pros", label: "Pros (one per line)", multiline: true },
					{ type: "text_input", action_id: "consHeading", label: "Cons heading", initial_value: DEFAULT_CONS_HEADING },
					{ type: "text_input", action_id: "cons", label: "Cons (one per line)", multiline: true },
					{ type: "text_input", action_id: "summary", label: "Summary or verdict (optional)", multiline: true },
					{
						type: "select",
						action_id: "headingLevel",
						label: "Heading level",
						options: [
							{ value: "2", label: "H2" },
							{ value: "3", label: "H3" },
							{ value: "4", label: "H4" },
						],
						initial_value: "2",
					},
				],
			},
		],
	};
}

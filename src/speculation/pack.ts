/**
 * Speculation Rules module: one `<script type="speculationrules">` in the
 * head of every public page (page:fragments), so browsers fetch the next page
 * from the edge cache as soon as a visitor is about to open it. Off by
 * default; its settings are on the Performance page (it has no page of its
 * own). See ./rules.ts for the rule set and docs/performance.md.
 */
import { type PluginContext, definePluginRoute } from "emdash";

import { cachedCtxFeatures, ctxFeatures, isOn, readSiteSetting, registerFeatures, registerSiteSetting, rememberSiteSetting } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { normalizeBase } from "../files/format.js";
import { parseInput } from "../shared.js";
import { SPECULATION_DEFAULTS, SPECULATION_SETTING, type SpeculationContext, parseSpeculationSettings, speculationRules, speculationScript, speculationSettingsSchema } from "./rules.js";

export const SPECULATION_FEATURE = "speculation";
/** File Downloads' switch and URL base (its download links are excluded while it's on). */
const FILES_FEATURE = "files";
const FILES_BASE_SETTING = "filesBase";

const FEATURES = [
	{
		id: SPECULATION_FEATURE,
		label: "Speculation Rules",
		description:
			"Browsers fetch a page as soon as a visitor is about to open it (on hover, by default), so the next page appears almost at once. Adds one speculation rules script to every public page. Settings are on the Performance page.",
		default: false,
	},
];
registerFeatures(FEATURES);
// Read on every page render: it comes with the feature switches' query (no query of its own).
registerSiteSetting(SPECULATION_SETTING);

/** The last stored value and its parsed settings, so a page render doesn't parse again. */
let memo: { raw: unknown; settings: ReturnType<typeof parseSpeculationSettings> } | null = null;

async function currentSettings(ctx: Pick<PluginContext, "settings">) {
	const read = await readSiteSetting(SPECULATION_SETTING).catch(() => null);
	// D1 unreadable outside the plugin context: through it instead.
	const raw = read ? read.value : await ctx.settings.get<unknown>(SPECULATION_SETTING).catch(() => null);
	if (memo && memo.raw === raw) return memo.settings;
	const settings = parseSpeculationSettings(raw);
	memo = { raw, settings };
	return settings;
}

async function context(ctx: Pick<PluginContext, "settings">, features: Record<string, boolean>): Promise<SpeculationContext> {
	if (!isOn(features, FILES_FEATURE)) return {};
	const read = await readSiteSetting(FILES_BASE_SETTING).catch(() => null);
	const raw = read ? read.value : await ctx.settings.get<unknown>(FILES_BASE_SETTING).catch(() => null);
	return { downloadBase: normalizeBase(raw) };
}

export function speculationPack(): PackModule {
	return {
		id: "speculation",
		label: "Speculation Rules",
		features: FEATURES,
		hooks: {
			"page:fragments": async (_event: unknown, ctx: PluginContext) => {
				// The same cached read the hook composer made for this render.
				const features = await cachedCtxFeatures(ctx);
				const settings = await currentSettings(ctx);
				return [{ kind: "html" as const, placement: "head" as const, key: "coywolf-speculation-rules", html: speculationScript(settings, await context(ctx, features)) }];
			},
		},
		routes: {
			/** The Performance page's Speculation Rules card: the switch, the settings and the rule set they make. */
			"speculation/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: PluginContext) => {
					const features = await ctxFeatures(ctx);
					const settings = parseSpeculationSettings(await ctx.settings.get<unknown>(SPECULATION_SETTING));
					const ruleContext = await context(ctx, features);
					return {
						enabled: isOn(features, SPECULATION_FEATURE),
						settings,
						defaults: SPECULATION_DEFAULTS,
						downloadBase: ruleContext.downloadBase ?? null,
						rules: speculationRules(settings, ruleContext),
					};
				},
			},

			/** Save the settings. Every cached page carries the rule set, so the pack's purge-after-save clears them. */
			"speculation/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const settings = parseInput(speculationSettingsSchema, ctx.input);
					await ctx.settings.set(SPECULATION_SETTING, settings);
					rememberSiteSetting(SPECULATION_SETTING, settings);
					memo = null;
					return { settings, rules: speculationRules(settings, await context(ctx, await ctxFeatures(ctx))) };
				},
			}),
		},
		// Its settings are a card on the Performance page (always listed).
		adminPages: [],
	};
}

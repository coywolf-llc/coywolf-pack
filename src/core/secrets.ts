/**
 * The plugin's EmDash `admin.settingsSchema`: API keys and tokens only.
 *
 * EmDash renders this schema as the plugin's generic Settings page and uses
 * the same schema to decide which settings are encrypted: a key declared
 * `type: "secret"` is encrypted on write and decrypted on read, and reading
 * an encrypted value whose key isn't declared secret throws. So every secret
 * stays declared here whatever the feature switches or module options say,
 * and the keys never change (stored values must keep working). A secret is
 * removed only with its feature, and only once nothing reads it: its stored
 * value is deleted (as discoveryBingApiKey was by 0.35.18–0.37.x), and no
 * schema-checked read covers its key until then. ctx.settings.get/list decode
 * against this schema and throw on an undeclared encrypted value; the pack
 * lists settings only under prefixes that don't cover a removed key
 * (settings.list("schema")). EmDash's Settings page reads only the declared
 * keys, and its getPluginSettings decrypts any stored envelope without the
 * schema, so neither throws.
 *
 * Every other setting is plain JSON, edited on its module's own admin page
 * (ctx.settings.get/set work for keys that aren't in the schema).
 *
 * The order below is the Settings page's order: the Cloudflare API token and
 * the three other keys first, then the older secrets it replaces (kept
 * declared so their stored values still decrypt; src/core/settings-enhance.ts
 * hides them while empty), then the Videos webhook secret, which the pack
 * fills in itself.
 *
 * Kept free of imports so tests can load it directly.
 */

export interface SecretSettingField {
	type: "secret";
	label: string;
	description?: string;
}

const OLDER_DESCRIPTION = "Not needed once the Cloudflare API token is saved.";

export const SECRET_SETTINGS = {
	cloudflareApiToken: {
		type: "secret",
		label: "Cloudflare API token",
		description:
			"One token for all of the pack's Cloudflare features. Create it in the Cloudflare dashboard (Manage Account → Account API Tokens), paste it here and save. Or set the CLOUDFLARE_API_TOKEN Worker secret.",
	},
	aiApiKey: {
		type: "secret",
		label: "AI API key",
		description: "For Anthropic, OpenAI or Gemini (Workers AI needs no key). The provider and model are on the AI Enrichment page.",
	},
	insightsFathomApiKey: {
		type: "secret",
		label: "Fathom API key",
		description: "For the Fathom card on the Insights page, where the site ID goes.",
	},
	insightsGoogleServiceAccount: {
		type: "secret",
		label: "Google service account key",
		description: "For the Search Console card on the Insights page. Paste the whole JSON key file.",
	},
	// The older tokens, one per feature: still read (after the Cloudflare API token), hidden on the Settings page when empty.
	usageApiToken: { type: "secret", label: "Older: Cloudflare usage token", description: OLDER_DESCRIPTION },
	cloudflareSetupToken: { type: "secret", label: "Older: Cloudflare Checkup setup token", description: OLDER_DESCRIPTION },
	imagesApiToken: { type: "secret", label: "Older: Clean Image URLs token", description: OLDER_DESCRIPTION },
	videosApiToken: { type: "secret", label: "Older: Videos Stream token", description: OLDER_DESCRIPTION },
	backupsCloudflareToken: { type: "secret", label: "Older: Backups retention token", description: OLDER_DESCRIPTION },
	socialImagesApiToken: { type: "secret", label: "Older: Social Images token", description: OLDER_DESCRIPTION },
	robotsRadarToken: { type: "secret", label: "Older: Radar token", description: OLDER_DESCRIPTION },
	filesR2SecretAccessKey: {
		type: "secret",
		label: "Older: File Downloads R2 secret access key",
		description: "For large uploads. Not needed once the Cloudflare API token is saved, unless you want a key limited to one bucket.",
	},
	videosWebhookSecret: {
		type: "secret",
		label: "Videos webhook secret (automatic)",
		description: "Filled in by Subscribe Stream webhook on the Videos page. Leave as is.",
	},
} as const satisfies Record<string, SecretSettingField>;

export type SecretSettingKey = keyof typeof SECRET_SETTINGS;

/**
 * The older secrets the Cloudflare API token replaces: the seven per-feature
 * Cloudflare tokens and the File Downloads R2 key. The Settings page hides
 * them while empty and puts the saved ones behind an "Older tokens" toggle.
 */
export const OLDER_SECRET_KEYS = [
	"usageApiToken",
	"cloudflareSetupToken",
	"imagesApiToken",
	"videosApiToken",
	"backupsCloudflareToken",
	"socialImagesApiToken",
	"robotsRadarToken",
	"filesR2SecretAccessKey",
] as const satisfies readonly SecretSettingKey[];

/** Secrets the Settings page never shows: the pack fills them in itself. */
export const HIDDEN_SECRET_KEYS = ["videosWebhookSecret"] as const satisfies readonly SecretSettingKey[];

/**
 * The schema EmDash sees: the pack's secrets plus any secret fields a module
 * declares. Non-secret fields are dropped, so they never appear on the
 * generic Settings page.
 */
// any: SettingField shape is EmDash's.
export function secretSettingsSchema(moduleSchemas: Array<Record<string, any> | undefined> = []): Record<string, SecretSettingField> {
	const out: Record<string, SecretSettingField> = { ...SECRET_SETTINGS };
	for (const schema of moduleSchemas) {
		for (const [key, field] of Object.entries(schema ?? {})) {
			if (field && field.type === "secret" && !(key in out)) out[key] = field as SecretSettingField;
		}
	}
	return out;
}

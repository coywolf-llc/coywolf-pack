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
 * value is deleted (as discoveryBingApiKey is by retireIndexNow), and no
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
 * Kept free of imports so tests can load it directly.
 */

export interface SecretSettingField {
	type: "secret";
	label: string;
	description?: string;
}

export const SECRET_SETTINGS = {
	aiApiKey: {
		type: "secret",
		label: "AI Enrichment — API key",
		description:
			"For Anthropic, OpenAI or Gemini (Workers AI needs no key). To get one: (1) sign in to your provider's developer console: platform.claude.com (Anthropic), platform.openai.com (OpenAI) or aistudio.google.com (Gemini); (2) add billing; (3) create an API key and copy it; (4) paste it here and save. Step-by-step guides for each provider, and the provider and model settings, are on the AI Enrichment page.",
	},
	filesR2SecretAccessKey: {
		type: "secret",
		label: "File Downloads — R2 secret access key",
		description:
			"For large uploads. To get one: (1) Cloudflare dashboard → R2 → Manage API tokens → Create Account API token; (2) choose Object Read & Write on the bucket bound as MEDIA; (3) create it and copy the Secret Access Key (shown once); (4) paste it here and save. The account ID, access key ID and bucket name go on the File Downloads page → Settings, which has the full step-by-step guide.",
	},
	videosApiToken: {
		type: "secret",
		label: "Videos — Cloudflare Stream API token",
		description:
			"To get one: (1) Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token; (2) under Permission policies, in a policy scoped to Entire Account, add Stream → Edit; (3) create it and copy the token (shown once); (4) paste it here and save. Or set the CF_STREAM_TOKEN Worker secret. The account ID and the full step-by-step guide are on the Videos page → Settings.",
	},
	videosWebhookSecret: {
		type: "secret",
		label: "Videos — Stream webhook signing secret",
		description: "Filled in by Subscribe Stream webhook on the Videos page. Leave as is.",
	},
	imagesApiToken: {
		type: "secret",
		label: "Clean Image URLs — Cloudflare API token",
		description:
			"Optional. Only for Set up media host on the Clean Image URLs page, which does the Cloudflare setup for you. To get one: (1) Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token; (2) under Permission policies, in a policy scoped to Specified Domains → the site's domain, add Zone → Read, Zone Settings → Edit, Transform Rules → Edit and DNS → Edit; (3) in a policy scoped to Entire Account, add Workers R2 Storage → Edit and Account Rulesets → Read; (4) create it, copy the token (shown once), paste it here and save. The Clean Image URLs page has a pre-filled form. Or set the IMAGES_API_TOKEN Worker secret.",
	},
	usageApiToken: {
		type: "secret",
		label: "Cloudflare usage — read-only API token",
		description:
			"Optional. Shows this site's D1 and Workers usage, the account's against its plan, and the estimated bill on the Performance page and the dashboard. To get one: (1) Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token; (2) under Permission policies, in a policy scoped to Entire Account, add Account Analytics → Read, Workers → Metadata Read-Only (finds this site's Worker and database and reads Workers Logs for the cache-warming estimate) and Account Settings → Read (to detect the plan); (3) create it, copy the token (shown once), paste it here and save. The Performance page has a pre-filled form. Or set the USAGE_API_TOKEN Worker secret (one token works for every site in the account). With Zone → Read added too, in a policy scoped to All Domains or this site's domain, the Discovery page shows whether Cloudflare's Crawler Hints is on; with Zone Settings → Read, Bot Management → Read and DNS → Read as well, the Cloudflare Checkup page reads the zone's settings.",
	},
	cloudflareSetupToken: {
		type: "secret",
		label: "Cloudflare Checkup — setup token",
		description:
			"Optional. Only for the one-click fixes on the Cloudflare Checkup page (Speed Brain off, Always Use HTTPS on, minimum TLS 1.2); reading the checkup uses the read-only Cloudflare usage token. To get one: (1) Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token; (2) under Permission policies, in a policy scoped to Specified Domains → this site's domain, add Zone → Read and Zone Settings → Edit; (3) create it, copy the token (shown once), paste it here and save. The Cloudflare Checkup page has a pre-filled form.",
	},
	backupsCloudflareToken: {
		type: "secret",
		label: "Backups — Cloudflare API token for retention",
		description:
			"Optional. Only for Retention on Cloudflare on the Backups page, which sets the backup bucket's lifecycle rule (and an optional lock) to match the retention days. To get one: (1) Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token; (2) under Permission policies, in a policy scoped to Entire Account, add Workers R2 Storage → Edit (and D1 → Edit to use the same token for restores); (3) create it, copy the token (shown once), paste it here and save. The Backups page has a pre-filled form. Or add Workers R2 Storage → Edit to the BACKUPS_API_TOKEN Worker secret's token.",
	},
	robotsRadarToken: {
		type: "secret",
		label: "Robots.txt — Cloudflare Radar API token",
		description:
			"Optional. Keeps the crawler list current from Cloudflare Radar each week. To get one: (1) Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token; (2) under Permission policies, in a policy scoped to Entire Account, add Radar → Read; (3) create it and copy the token (shown once); (4) paste it here and save. Or set the RADAR_API_TOKEN Worker secret. The full step-by-step guide is on the Robots.txt page → Bots.",
	},
} as const satisfies Record<string, SecretSettingField>;

export type SecretSettingKey = keyof typeof SECRET_SETTINGS;

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

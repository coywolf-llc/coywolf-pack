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
 * value is deleted (as discoveryBingApiKey is by retireIndexNow), and no code
 * lists all of the plugin's settings (EmDash's Settings page reads only the
 * declared keys).
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
			"For large uploads. To get one: (1) Cloudflare dashboard → R2 → Manage API tokens → Create Account API token; (2) choose Object Read & Write on the bucket bound as MEDIA; (3) create it and copy the Secret Access Key (shown once); (4) paste it here and save. The account ID, access key ID and bucket name go on the Files page → Settings, which has the full step-by-step guide.",
	},
	videosApiToken: {
		type: "secret",
		label: "Videos — Cloudflare Stream API token",
		description:
			"To get one: (1) Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token; (2) add the permission Account → Stream → Edit and include your account; (3) create it and copy the token (shown once); (4) paste it here and save. Or set the CF_STREAM_TOKEN Worker secret. The account ID and the full step-by-step guide are on the Videos page → Settings.",
	},
	videosWebhookSecret: {
		type: "secret",
		label: "Videos — Stream webhook signing secret",
		description: "Filled in by Subscribe Stream webhook on the Videos page. Leave as is.",
	},
	imagesApiToken: {
		type: "secret",
		label: "Clean image URLs — Cloudflare API token",
		description:
			"Optional. Only for Set up media host on the Clean Image URLs page, which does the Cloudflare setup for you. To get one: (1) Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token; (2) add the permissions Zone → Zone → Read, Zone → Zone Settings → Edit, Zone → Transform Rules → Edit, Zone → DNS → Edit, Account → Workers R2 Storage → Edit and Account → Account Rulesets → Read; (3) include your account and the site's zone; (4) create it, copy the token (shown once), paste it here and save. Or set the IMAGES_API_TOKEN Worker secret.",
	},
	usageApiToken: {
		type: "secret",
		label: "Cloudflare usage — read-only API token",
		description:
			"Optional. Shows this site's D1 and Workers usage, the account's against its plan, and the estimated bill on the Performance page and the dashboard. To get one: (1) Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token; (2) add the permissions Account → Account Analytics → Read, Workers → Metadata Read-Only (All Workers; finds this site's Worker and database and reads Workers Logs for the cache-warming estimate) and Account → Account Settings → Read (to detect the plan); (3) create it, copy the token (shown once), paste it here and save. Or set the USAGE_API_TOKEN Worker secret (one token works for every site in the account). With Zone → Zone → Read added too (all zones, or this site's), the Discovery page shows whether Cloudflare's Crawler Hints is on.",
	},
	robotsRadarToken: {
		type: "secret",
		label: "Robots.txt Rules — Cloudflare Radar API token",
		description:
			"Optional. Keeps the crawler list current from Cloudflare Radar each week. To get one: (1) Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token; (2) add the permission Account → Radar → Read and include your account; (3) create it and copy the token (shown once); (4) paste it here and save. Or set the RADAR_API_TOKEN Worker secret. The full step-by-step guide is on the Robots.txt page → Bots.",
	},
} as const satisfies Record<string, SecretSettingField>;

export type SecretSettingKey = keyof typeof SECRET_SETTINGS;

/**
 * The schema EmDash sees: the pack's secrets plus any secret fields a module
 * declares. Non-secret fields are dropped, so they never appear on the
 * generic Settings page.
 */
// biome-ignore lint/suspicious/noExplicitAny: SettingField shape is EmDash's.
export function secretSettingsSchema(moduleSchemas: Array<Record<string, any> | undefined> = []): Record<string, SecretSettingField> {
	const out: Record<string, SecretSettingField> = { ...SECRET_SETTINGS };
	for (const schema of moduleSchemas) {
		for (const [key, field] of Object.entries(schema ?? {})) {
			if (field && field.type === "secret" && !(key in out)) out[key] = field as SecretSettingField;
		}
	}
	return out;
}

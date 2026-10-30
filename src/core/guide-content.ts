/**
 * Step-by-step guides for the API keys and tokens some features need, as
 * static HTML strings (trusted: written here, never from user data). Shown in
 * a closed <details> next to each credential field on module pages
 * (src/admin/guides.tsx) and on EmDash's generic plugin Settings page, where
 * the admin enhancement script (src/core/settings-enhance.ts) swaps each
 * field's plain-text description for the same guide.
 *
 * Kept free of imports so tests can load it directly.
 */

export type GuideId = "anthropic" | "openai" | "gemini" | "workers-ai" | "r2" | "stream" | "radar" | "media-host" | "images-token";

export interface Guide {
	summary: string;
	/** Each step's HTML. */
	steps: string[];
	/** Optional note under the steps (HTML). */
	note?: string;
}

const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noreferrer" class="text-kumo-link underline">${text}</a>`;
const code = (text: string) => `<code class="rounded bg-kumo-tint px-1 text-xs">${text}</code>`;
const b = (text: string) => `<strong class="font-medium">${text}</strong>`;

/** Creating a Cloudflare API token: the steps every token guide shares. */
const cloudflareTokenSteps = (permission: string, zone = false) => [
	`Sign in to the ${link("https://dash.cloudflare.com/profile/api-tokens", "Cloudflare dashboard → My Profile → API Tokens")}.`,
	`Select ${b("Create Token")}, then ${b("Create Custom Token → Get started")}.`,
	"Name it after this site so you'll recognize it later.",
	`Under Permissions, choose ${permission}.`,
	`Under Account Resources, choose ${b("Include → your account")}.`,
	...(zone ? [`Under Zone Resources, choose ${b("Include → Specific zone → your site's domain")}.`] : []),
	`Select ${b("Continue to summary")}, then ${b("Create Token")}.`,
	"Copy the token right away. Cloudflare shows it only once.",
];

export const GUIDES: Record<GuideId, Guide> = {
	anthropic: {
		summary: "How to get an Anthropic API key",
		steps: [
			`Sign in to the ${link("https://platform.claude.com/settings/keys", "Claude Console")} (create an account if you don't have one).`,
			`Add a payment method or credits under ${b("Billing")}. Keys don't work without them.`,
			`Go to ${b("API Keys")} and select ${b("Create Key")}. Name it after this site.`,
			"Copy the key (it starts with sk-ant-). It's shown only once.",
			"Paste it into the API key field and save.",
		],
		note: "Each analyzed entry or image is one model call, billed by Anthropic. The daily call limit caps what you spend.",
	},
	openai: {
		summary: "How to get an OpenAI API key",
		steps: [
			`Sign in to the ${link("https://platform.openai.com/api-keys", "OpenAI Platform → API keys")}.`,
			`Add a payment method or credits under ${b("Settings → Billing")}. Keys don't work without them.`,
			`Select ${b("Create new secret key")}, name it after this site, and keep the default permissions.`,
			"Copy the key (it starts with sk-). It's shown only once.",
			"Paste it into the API key field and save.",
		],
		note: "Each analyzed entry or image is one model call, billed by OpenAI. The daily call limit caps what you spend.",
	},
	gemini: {
		summary: "How to get a Google Gemini API key",
		steps: [
			`Sign in to ${link("https://aistudio.google.com/apikey", "Google AI Studio → API keys")} with a Google account.`,
			`Select ${b("Create API key")} and pick (or create) a Google Cloud project.`,
			"Copy the key.",
			"Paste it into the API key field and save.",
		],
		note: "The free tier has low rate limits. For steady use, turn on billing for the project in Google AI Studio.",
	},
	"workers-ai": {
		summary: "How to connect Workers AI (no key needed)",
		steps: [
			`Open your site's ${code("wrangler.jsonc")}.`,
			`Add ${code('"ai": { "binding": "AI" }')} at the top level.`,
			"Deploy the site. This page then shows the binding as connected.",
		],
		note: "Workers AI is billed to your Cloudflare account, with a daily free allowance.",
	},
	r2: {
		summary: "How to get the R2 account ID and keys",
		steps: [
			`In the ${link("https://dash.cloudflare.com/?to=/:account/r2/overview", "Cloudflare dashboard → R2")}, copy your ${b("Account ID")} (shown on the R2 overview page) into R2 account ID on the Files page → Settings.`,
			`Under Buckets, note the name of the bucket bound as ${code("MEDIA")} in your ${code("wrangler.jsonc")}. Enter it as the R2 bucket name.`,
			`Select ${b("Manage API tokens")} (on the R2 overview page), then ${b("Create Account API token")}.`,
			`Choose the ${b("Object Read &amp; Write")} permission and ${b("Apply to specific buckets only")} → that bucket.`,
			`Select ${b("Create API Token")}. Copy the ${b("Access Key ID")} and ${b("Secret Access Key")}. The secret is shown only once.`,
			"Paste them into their fields and save. The secret is stored encrypted.",
		],
	},
	stream: {
		summary: "How to get the Stream account ID and API token",
		steps: [
			`In the ${link("https://dash.cloudflare.com/?to=/:account/stream", "Cloudflare dashboard → Stream")}, copy your ${b("Account ID")} (in the right-hand column, or from the address bar after dash.cloudflare.com/) into Cloudflare account ID on the Videos page → Settings.`,
			...cloudflareTokenSteps(b("Account → Stream → Edit")),
			"Paste the token into Stream API token and save. It's stored encrypted.",
		],
		note: `Or set them as Worker variables instead: ${code("CF_ACCOUNT_ID")}, and the token with ${code("npx wrangler secret put CF_STREAM_TOKEN")}.`,
	},
	radar: {
		summary: "How to get a Cloudflare Radar API token",
		steps: [...cloudflareTokenSteps(b("Account → Radar → Read")), "Paste the token into Cloudflare Radar API token and save. It's stored encrypted."],
		note: `Radar's API is free. Or set the token as a Worker secret instead: ${code("npx wrangler secret put RADAR_API_TOKEN")}.`,
	},
	"media-host": {
		summary: "How to set up a media host by hand in the Cloudflare dashboard",
		steps: [
			`Find the R2 bucket bound as ${code("MEDIA")} in your site's ${code("wrangler.jsonc")} (its ${code("bucket_name")}). The media host serves that bucket, at a subdomain of the site's own domain, such as ${code("media.example.com")}.`,
			`Turn on Image Transformations: ${link("https://dash.cloudflare.com/?to=/:account/images/transformations", "Cloudflare dashboard → Images → Transformations")}, find the site's domain and select ${b("Enable for zone")}. Leave ${b("Resize images from any origin")} off: the media host is on the same domain.`,
			`Connect the domain to the bucket: ${link("https://dash.cloudflare.com/?to=/:account/r2/overview", "R2")} → the media bucket → ${b("Settings → Custom Domains → Add")}. Enter ${code("media.example.com")}, set the minimum TLS version to 1.2, and confirm. Cloudflare adds the DNS record; the certificate takes a few minutes.`,
			`Add the first URL rewrite rule: the site's domain → ${b("Rules → Overview → Create rule → URL Rewrite Rule")}. Name it ${code("media.example.com: /s/&lt;W&gt;x&lt;H&gt;/&lt;file&gt; → cropped resize (Coywolf Pack clean image URLs)")}. Choose ${b("Custom filter expression → Edit expression")} and enter ${code('(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*x*/*")')}. Under Path, choose ${b("Rewrite to… → Dynamic")} and enter ${code('wildcard_replace(http.request.uri.path, "/s/*x*/*", "/cdn-cgi/image/width=${1},height=${2},fit=cover,format=auto,quality=85/${3}")')}. Leave Query as is and deploy.`,
			`Add the second rule, named ${code("media.example.com: /s/&lt;W&gt;/&lt;file&gt; → resize to width (Coywolf Pack clean image URLs)")}, with the expression ${code('(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*/*" and not http.request.uri.path wildcard "/s/*x*/*")')} and the dynamic path ${code('wildcard_replace(http.request.uri.path, "/s/*/*", "/cdn-cgi/image/width=${1},format=auto,quality=85/${2}")')}. Deploy it.`,
			`Turn on Smart Tiered Cache (free): the site's domain → ${b("Caching → Tiered Cache")} → ${b("Smart Tiered Caching")}. A data center that hasn't cached an image yet then asks a nearby Cloudflare cache instead of going back to R2.`,
			`Use your own host name in place of ${code("media.example.com")} everywhere (keep the names exactly as shown otherwise: Set up media host recognizes its rules by name).`,
			`Enter the host as the Media host on this page and select ${b("Check")}. When every check passes, save. Or set it in ${code("astro.config.mjs")}: ${code('coywolfPlugin({ images: { cdn: "https://media.example.com" } })')}.`,
		],
		note: "Cloudflare's Free plan includes 5,000 unique image transformations a month (each new size of each image counts once a month). Beyond that, transformations need a paid Cloudflare Images plan.",
	},
	"images-token": {
		summary: "How to get a Cloudflare API token for Set up media host",
		steps: [
			`In the ${link("https://dash.cloudflare.com/", "Cloudflare dashboard")}, open the site's domain and copy the ${b("Account ID")} from the right-hand column (API section) into Cloudflare account ID.`,
			...cloudflareTokenSteps(
				`these six: ${b("Zone → Zone → Read")}, ${b("Zone → Zone Settings → Edit")}, ${b("Zone → Transform Rules → Edit")}, ${b("Zone → DNS → Edit")}, ${b("Account → Workers R2 Storage → Edit")} and ${b("Account → Account Rulesets → Read")}`,
				true,
			),
			"Paste the token into Cloudflare API token. Save it to keep it (stored encrypted), or leave it unsaved to use it just this once.",
		],
		note: `The token is used only for the setup, and only with api.cloudflare.com. You can delete it in Cloudflare afterward. Or set it as a Worker secret instead: ${code("npx wrangler secret put IMAGES_API_TOKEN")}.`,
	},
};

/**
 * What the generic Settings page shows for each secret once enhanced: a short
 * plain description, then the guides (closed). Keys match SECRET_SETTINGS.
 */
export const SETTINGS_PAGE_GUIDES: Record<string, { intro: string; guides: GuideId[] }> = {
	aiApiKey: {
		intro: "For Anthropic, OpenAI or Gemini (Workers AI needs no key). The provider and model settings are on the AI Enrichment page.",
		guides: ["anthropic", "openai", "gemini"],
	},
	filesR2SecretAccessKey: {
		intro: "For large uploads. The account ID, access key ID and bucket name go on the Files page → Settings.",
		guides: ["r2"],
	},
	videosApiToken: {
		intro: "Or set the CF_STREAM_TOKEN Worker secret. The account ID goes on the Videos page → Settings.",
		guides: ["stream"],
	},
	imagesApiToken: {
		intro: "Optional. Only for Set up media host on the Clean Image URLs page. Or set the IMAGES_API_TOKEN Worker secret.",
		guides: ["images-token"],
	},
	robotsRadarToken: {
		intro: "Optional. Keeps the crawler list current from Cloudflare Radar each week. Or set the RADAR_API_TOKEN Worker secret.",
		guides: ["radar"],
	},
};

/** A guide as a closed <details> (HTML), styled with the admin's own classes. */
export function guideHtml(guide: Guide): string {
	const steps = guide.steps.map((s) => `<li>${s}</li>`).join("");
	return `<details class="rounded-md border border-kumo-line text-sm"><summary class="cursor-pointer px-3 py-2 font-medium" style="display:list-item">${guide.summary}</summary><div class="space-y-2 border-t border-kumo-line px-3 py-3"><ol class="space-y-1.5" style="list-style:decimal;padding-inline-start:1.25rem">${steps}</ol>${
		guide.note ? `<p class="text-xs text-kumo-subtle">${guide.note}</p>` : ""
	}</div></details>`;
}

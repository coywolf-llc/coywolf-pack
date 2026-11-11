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

export type GuideId =
	| "anthropic"
	| "openai"
	| "gemini"
	| "workers-ai"
	| "cloudflare-token"
	| "usage-token"
	| "r2"
	| "files-token"
	| "stream"
	| "radar"
	| "media-host"
	| "images-token"
	| "crawler-hints-token"
	| "checkup-read-token"
	| "checkup-setup-token"
	| "tracking-params"
	| "backups-token"
	| "backups-retention"
	| "insights-token"
	| "web-analytics"
	| "fathom"
	| "search-console"
	| "browser-run-token";

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
/**
 * A bulleted list (HTML), one item per <li>: three or more things to add, select or enter are a list, never one
 * inline run (a child list inside a step). EmDash's admin stylesheet (Tailwind's preflight) removes list styles, so
 * the bullets and indent are inline styles, as on guideHtml's numbered <ol>.
 */
export const bullets = (items: string[]) => `<ul class="mt-1 space-y-0.5" style="list-style:disc;padding-inline-start:1.25rem">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

/** A permission for Cloudflare's pre-filled token form: a short key from Cloudflare's permission reference. */
export interface TokenPermission {
	key: string;
	type: "read" | "edit";
}

/**
 * Cloudflare's pre-filled form for a new account API token, with the name and
 * the permissions it can pre-select (developers.cloudflare.com/fundamentals/
 * api/how-to/account-owned-token-template/; a key it can't resolve is named in
 * a notice on the form, not dropped silently).
 */
export function tokenFormUrl(name: string, permissions: TokenPermission[]): string {
	return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(permissions))}&name=${encodeURIComponent(name)}`;
}

/** The plugin's Settings page, where the Cloudflare API token is saved (a full page load from a guide's static link). */
const SETTINGS_PAGE = "/_emdash/admin/plugins-manager/coywolf-pack/settings";

/**
 * A permission of the Cloudflare API token, as Cloudflare's token editor
 * names it. `form`: its key for the pre-filled form, only where Cloudflare's
 * permission reference documents one (developers.cloudflare.com/fundamentals/
 * api/how-to/account-owned-token-template/); the others are added by hand.
 * `scope`: the policy it goes in (zone permissions are listed only in a
 * policy scoped to domains). `for`: which features need it.
 */
export interface CloudflarePermission {
	name: string;
	/** How to find its row in the editor's search, where the name alone doesn't settle it (HTML). */
	find?: string;
	scope: "account" | "zone";
	form?: TokenPermission;
	for: string;
}

/**
 * Everything the pack's Cloudflare features ask of the one token. D1 → Edit
 * is never here: restores keep their own token (the BACKUPS_API_TOKEN Worker
 * secret), so the token saved in the database can't rewrite the database.
 *
 * Added by hand although Cloudflare may have a key for them: Workers →
 * Metadata Read-Only (Cloudflare doesn't document which permission the
 * `workers_scripts` key selects, and the Workers Logs query needs this one)
 * and Cache → Purge (the `cache` key's "purge" type has no documented example).
 *
 * The zone rule and cache names are the editor's own rows (checked 2026-11): Zone Transform Rules under "Rules &
 * Configuration"; Cache ("Grants access to purge cache") and Cache Settings ("Grants write access to cache settings
 * phase") under "Cache & Performance". Bot Management is the editor's name for its row too (confirmed 2026-11).
 */
export const CLOUDFLARE_PERMISSIONS = {
	accountAnalytics: { name: "Account Analytics → Read", scope: "account", form: { key: "account_analytics", type: "read" }, for: "Cloudflare usage and Insights" },
	accountSettings: { name: "Account Settings → Read", scope: "account", form: { key: "account_settings", type: "read" }, for: "finding the account and its plan" },
	r2: { name: "Workers R2 Storage → Edit", scope: "account", form: { key: "workers_r2", type: "edit" }, for: "Set up media host, Backups retention and large uploads" },
	stream: { name: "Stream → Edit", scope: "account", form: { key: "stream", type: "edit" }, for: "Videos" },
	workersMetadata: {
		name: "Workers → Metadata Read-Only",
		scope: "account",
		for: "Cloudflare usage (finds this site's Worker and database, and reads Workers Logs), and finding the R2 bucket names in this site's Worker bindings for large uploads, Set up media host and Backups retention",
	},
	rulesets: { name: "Account Rulesets → Read", scope: "account", for: "Set up media host" },
	browserRun: { name: "Browser Run → Edit", scope: "account", for: "Social Images (called Browser Rendering in some accounts)" },
	radar: { name: "Radar → Read", scope: "account", for: "the Robots.txt crawler list" },
	zone: { name: "Zone → Read", scope: "zone", form: { key: "zone", type: "read" }, for: "finding the site's zone" },
	zoneSettings: { name: "Zone Settings → Edit", scope: "zone", form: { key: "zone_settings", type: "edit" }, for: "Cloudflare Checkup and Set up media host" },
	dns: { name: "DNS → Edit", scope: "zone", form: { key: "dns", type: "edit" }, for: "Set up media host and Cloudflare Checkup" },
	analytics: { name: "Analytics → Read", scope: "zone", form: { key: "analytics", type: "read" }, for: "Insights (edge errors and crawlers)" },
	transformRules: { name: "Zone Transform Rules → Edit", scope: "zone", find: "search for “transform”; it's under Rules &amp; Configuration", for: "Set up media host" },
	cacheRules: {
		name: "Cache Settings → Edit",
		scope: "zone",
		find: `search for “cache”, which lists two rows under Cache &amp; Performance: pick the one named ${b("Cache Settings")} (“Grants write access to cache settings phase”), not the one named just Cache, and set it to Edit`,
		for: "the media host's cache rule (Performance page)",
	},
	cachePurge: {
		name: "Cache → Purge",
		scope: "zone",
		find: `search for “cache”, which lists two rows under Cache &amp; Performance: pick the one named just ${b("Cache")} (“Grants access to purge cache”), not Cache Settings, and set it to Purge`,
		for: "clearing the media host's images",
	},
	botManagement: { name: "Bot Management → Read", scope: "zone", for: "Cloudflare Checkup's bot rows" },
} as const satisfies Record<string, CloudflarePermission>;

export type CloudflarePermissionId = keyof typeof CLOUDFLARE_PERMISSIONS;

const PERMISSION_LIST: CloudflarePermission[] = Object.values(CLOUDFLARE_PERMISSIONS);
/** "A, B and C" */
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const named = (list: CloudflarePermission[]) => andList(list.map((p) => b(p.name)));
/** A permission as a list item: its name, and how to find its row where it has a hint. */
const toFind = (p: CloudflarePermission) => `${b(p.name)}${p.find ? ` (${p.find})` : ""}`;
const pick = (scope: "account" | "zone", prefilled: boolean) => PERMISSION_LIST.filter((p) => p.scope === scope && Boolean(p.form) === prefilled);

/**
 * The Cloudflare API token's pre-filled form: its name, the permissions it pre-selects, what it should show (each
 * policy with a child list of its permissions), and what's added by hand (a child list per policy, with the hints).
 */
export const CLOUDFLARE_TOKEN_FORM = {
	name: "Coywolf Pack",
	keys: PERMISSION_LIST.flatMap((p) => (p.form ? [p.form] : [])),
	shows: `two policies. The one scoped to ${b("Entire Account")} has:${bullets(pick("account", true).map((p) => b(p.name)))}The one scoped to domains has:${bullets(pick("zone", true).map((p) => b(p.name)))}`,
	add: `Add the rest by hand (search for each name). In the ${b("Entire Account")} policy:${bullets(pick("account", false).map(toFind))}In the domains policy:${bullets(pick("zone", false).map(toFind))}You can skip any whose feature you don't use (the note below says which is which).`,
};

/** The steps that create the Cloudflare API token with the pre-filled form. */
const createTokenSteps = [
	`Open ${link(tokenFormUrl(CLOUDFLARE_TOKEN_FORM.name, CLOUDFLARE_TOKEN_FORM.keys), "Cloudflare's token form, pre-filled")} (Cloudflare dashboard → Manage Account → Account API Tokens → Create Token). If you have more than one account, pick the site's. The form should show the name ${b(CLOUDFLARE_TOKEN_FORM.name)} and ${CLOUDFLARE_TOKEN_FORM.shows}`,
	`Under ${b("Permission policies")}, each policy has a scope dropdown: ${b("Entire Account")} lists account permissions; zone permissions show only in a policy set to ${b("All Domains")} or ${b("Specified Domains")}. ${CLOUDFLARE_TOKEN_FORM.add}`,
	`Set the domains policy's scope to ${b("Specified Domains")} and pick this site's domain (recommended: the token can then change only this site). To use one token on every site in the account, choose ${b("All Domains")} instead.`,
	`Select ${b("Create Token")} at the bottom. (In Cloudflare's older token editor: Permissions, then Account Resources and Zone Resources, then ${b("Continue to summary")} and ${b("Create Token")}.)`,
	`Copy the token right away. Cloudflare shows it only once. (If Cloudflare later refuses it, an account token may not cover that API yet: create the same token under ${link("https://dash.cloudflare.com/profile/api-tokens", "My Profile → API Tokens")} instead.)`,
];

/**
 * A module page's guide: the feature uses the Cloudflare API token, which
 * needs `needs` here; where to create the token, and how to add a missing
 * permission. `before`: the feature's own steps first (a bucket name).
 */
function featureGuide(o: { summary: string; needs: CloudflarePermissionId[]; before?: string[]; note?: string }): Guide {
	const needs = o.needs.map((id) => CLOUDFLARE_PERMISSIONS[id] as CloudflarePermission);
	const policies = [...new Set(needs.map((p) => (p.scope === "account" ? `${b("Entire Account")} policy` : "domains policy")))];
	// Three or more: a child list, each with its search hint. One or two stay inline, their hints in the next step.
	const listed = needs.length >= 3;
	const finds = listed ? [] : needs.filter((p) => p.find).map((p) => ` For ${b(p.name)}, ${p.find}.`);
	return {
		summary: o.summary,
		steps: [
			...(o.before ?? []),
			`This uses the Cloudflare API token from the plugin's ${link(SETTINGS_PAGE, "Settings page")} (or the ${code("CLOUDFLARE_API_TOKEN")} Worker secret). ${listed ? `Here it needs:${bullets(needs.map(toFind))}` : `Here it needs ${named(needs)}.`}`,
			`No token yet? Create it with the steps under ${b("Cloudflare API token")} on the ${link(SETTINGS_PAGE, "Settings page")}: one token covers every feature, so you make it once.`,
			`Token missing a permission? Open ${link("https://dash.cloudflare.com/?to=/:account/api-tokens", "Cloudflare dashboard → Manage Account → Account API Tokens")} (or ${link("https://dash.cloudflare.com/profile/api-tokens", "My Profile → API Tokens")}, wherever you created it) and select ${b("⋯ → Edit")} next to the token. Under ${b("Permission policies")}, add it to the ${andList(policies)} (search for its name) and save.${finds.join("")} The token itself doesn't change, so there's nothing to paste again.`,
		],
		...(o.note ? { note: o.note } : {}),
	};
}

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
	"cloudflare-token": {
		summary: "How to create the Cloudflare API token",
		steps: [
			...createTokenSteps,
			`Paste it into ${b("Cloudflare API token")} on the plugin's Settings page and save. It's stored encrypted. Or set it as a Worker secret instead: ${code("npx wrangler secret put CLOUDFLARE_API_TOKEN")}.`,
		],
		note: `Which feature needs which:${bullets(PERMISSION_LIST.map((p) => `${b(p.name)}: ${p.for}`))}<p>Restores never use this token: they keep the ${code("BACKUPS_API_TOKEN")} Worker secret (D1 → Edit), so this token doesn't need D1. Older per-feature tokens keep working until this one is saved; then remove them on the Features page.</p>`,
	},
	"usage-token": featureGuide({
		summary: "How Cloudflare usage reads your account",
		needs: ["accountAnalytics", "accountSettings", "workersMetadata"],
		note: "Account Settings → Read detects your plan; Workers → Metadata Read-Only finds this site's Worker and database and reads Workers Logs for the cache-warming estimate. The older Cloudflare usage token and USAGE_API_TOKEN Worker secret keep working until the Cloudflare API token is saved.",
	}),
	"files-token": featureGuide({
		summary: "How large uploads use the Cloudflare API token",
		before: [
			`The pack finds the bucket itself: the ${code("bucket_name")} bound as ${code("FILES")} in your ${code("wrangler.jsonc")}, else as ${code("MEDIA")}. The page then shows it as ${b("Found")}. If it says it couldn't, enter the bucket name: find it under Buckets in the ${link("https://dash.cloudflare.com/?to=/:account/r2/overview", "Cloudflare dashboard → R2")}.`,
		],
		needs: ["r2", "workersMetadata"],
		note: "The pack makes the R2 keys from the token (R2's access key ID is the token's ID, and its secret is the token's SHA-256), so there's nothing else to paste. Workers → Metadata Read-Only only finds the bucket name; a token without it works once the name is entered. A bucket name saved under Advanced wins over the one found, and a key pair for one bucket wins over the token.",
	}),
	r2: {
		summary: "How to get an R2 key for one bucket (optional)",
		steps: [
			`In the ${link("https://dash.cloudflare.com/?to=/:account/r2/overview", "Cloudflare dashboard → R2")}, copy your ${b("Account ID")} (shown on the R2 overview page) into R2 account ID on the Files page → Settings.`,
			`Under Buckets, note the name of the bucket bound as ${code("MEDIA")} in your ${code("wrangler.jsonc")}. Enter it as the R2 bucket name, unless the Files page already shows it as ${b("Found")}.`,
			`Select ${b("Manage API tokens")} (on the R2 overview page), then ${b("Create Account API token")}.`,
			`Choose the ${b("Object Read &amp; Write")} permission and ${b("Apply to specific buckets only")} → that bucket.`,
			`Select ${b("Create API Token")}. Copy the ${b("Access Key ID")} and ${b("Secret Access Key")}. The secret is shown only once.`,
			"Paste them into their fields and save. The secret is stored encrypted.",
		],
		note: "Only needed without the Cloudflare API token, or to limit large uploads to one bucket: a saved key pair wins over the token.",
	},
	stream: featureGuide({
		summary: "How Videos uses the Cloudflare API token",
		needs: ["stream"],
		note: `The account is the token's own; if it sees more than one, enter the account ID under Advanced (or set ${code("CF_ACCOUNT_ID")}). The older Stream token and ${code("CF_STREAM_TOKEN")} Worker secret keep working until the Cloudflare API token is saved.`,
	}),
	radar: featureGuide({
		summary: "How the crawler list uses the Cloudflare API token",
		needs: ["radar"],
		note: `Radar's API is free. The older Radar token and ${code("RADAR_API_TOKEN")} Worker secret keep working until the Cloudflare API token is saved.`,
	}),
	"crawler-hints-token": featureGuide({
		summary: "How the pack reads Crawler Hints",
		needs: ["zone"],
		note: "The token only reads it. Cloudflare doesn't let API tokens change Crawler Hints, so the switch itself is always in the Cloudflare dashboard (Turn on in Cloudflare).",
	}),
	"checkup-read-token": featureGuide({
		summary: "How the checkup reads the zone's settings",
		needs: ["zone", "zoneSettings", "dns", "botManagement"],
		note: `Then come back to this page and select ${b("Check again")}. Zone Settings → Edit and DNS → Edit include reading.`,
	}),
	"checkup-setup-token": featureGuide({
		summary: "How the one-click fixes use the Cloudflare API token",
		needs: ["zone", "zoneSettings"],
		note: "Each fix changes one zone setting, and only when it isn't already set.",
	}),
	"tracking-params": {
		summary: "How to serve links with tracking parameters from the cache",
		steps: [
			`Open the site's ${code("src/worker.ts")}. On the Coywolf sites it exports ${code("default")} as ${code("{ ...handler, async fetch(…) { return emdashUncachedByDefault(…) }, scheduled: createScheduledHandler() }")}.`,
			`Add ${code('import { stripTrackingParams } from "@coywolf/emdash/worker";')} at the top.`,
			`Wrap that whole object, changing nothing inside it: ${code("export default stripTrackingParams({ …the same object… } satisfies ExportedHandler);")}. Keep the ${code("fetch")} with ${code("emdashUncachedByDefault")}: it keeps the admin's login redirect out of the cache. The docs have the full file.`,
			`Check the compatibility date in ${code("wrangler.jsonc")}: 2025-11-17 or later (or the ${code("enable_ctx_exports")} flag), so the Worker can call itself through its cache. A ${code("SELF")} service binding works too.`,
			`Deploy, then request a page twice with a tracking parameter: ${code("curl -sI 'https://your-site/?utm_source=test' | grep -i coywolf-tracking")} prints ${code("coywolf-tracking-params: removed")}. Then come back here: the row says ${b("Removed before the cache")} once a tracked visit was answered from the cache. Try one site first (the docs' first rollout step).`,
		],
		note: "Only links with tracking parameters run the Worker (once, without rendering); every other request is served from the cache as before. Analytics in the browser still see the parameters. Each such request is billed twice: the request and the call through the cache.",
	},
	"insights-token": featureGuide({
		summary: "How Insights reads Cloudflare's analytics",
		needs: ["accountAnalytics", "accountSettings", "zone", "analytics"],
		note: `Account Analytics → Read is for Core Web Vitals; Zone → Read and Analytics → Read are for edge errors and crawlers. Then select ${b("Refresh")}. Cloudflare's HTTP analytics are sampled, so counts are estimates. Every plan keeps at least 31 days, and a Free zone can read 30 days at a time.`,
	}),
	"web-analytics": {
		summary: "How to add the site to Cloudflare Web Analytics",
		steps: [
			`Open ${link("https://dash.cloudflare.com/?to=/:account/web-analytics", "Cloudflare dashboard → Web Analytics")} and select ${b("Add a site")}. Enter the site's domain (for example ${code("example.com")}) and finish.`,
			`Open the site's ${b("Manage site")} page and find the JavaScript snippet. Copy the token from it: the 32 letters and digits after ${code("&quot;token&quot;:")} in ${code("data-cf-beacon")}.`,
			`Paste the token into ${b("Web Analytics token")} on this page and save, then turn on ${b("Web Analytics beacon")}. The pack adds the beacon to every public page and clears the cached pages, so it's on them at once.`,
			"If Cloudflare's own automatic setup is on for the site, pages may get the beacon from Cloudflare instead. Cloudflare doesn't document whether it reaches pages a Worker serves, so the pack's beacon is the dependable way. The two never double up: the pack's script does nothing on a page that already has the beacon.",
			"The card reads the numbers with the Cloudflare API token from the plugin's Settings page (Account Analytics → Read, and Account Settings → Read to find the site). They show after the first visits; a low-traffic site needs a few days.",
		],
		note: "Web Analytics sets no cookies, uses no localStorage, doesn't fingerprint visitors by IP address or user agent, and doesn't log query strings. The beacon loads from static.cloudflareinsights.com and reports to cloudflareinsights.com. CLS is measured in Chromium browsers only.",
	},
	fathom: {
		summary: "How to get a Fathom site ID and API key",
		steps: [
			`Find the site ID: in ${link("https://app.usefathom.com/", "Fathom")}, open the site's settings; the site ID is the code of letters shown there. It's also the ${code("data-site")} value in the site's Fathom embed code. Enter it as ${b("Fathom site ID")}.`,
			`Open ${link("https://app.usefathom.com/api", "Fathom → API")} and select ${b("Create new")}. Name the key after this site.`,
			`Under permissions, choose ${b("Site-specific")} with read access to this site only, or ${b("Read only (all sites)")}. The card only reads, so never choose Admin.`,
			`Select ${b("Save changes")} and copy the key right away. Fathom shows it only once.`,
			`Paste it into ${b("Fathom API key")} on this page and save. It's stored encrypted, and the page never shows it again.`,
		],
		note: "Each API request counts toward your Fathom plan's monthly pageviews. The card makes four requests when it reads, at most once an hour and only while someone has this page open.",
	},
	"search-console": {
		summary: "How to connect Google Search Console with a service account",
		steps: [
			`In the ${link("https://console.cloud.google.com/projectselector2/home/dashboard", "Google Cloud console")}, pick a project or create one (named after the site, for example).`,
			`Turn on the API: open ${link("https://console.cloud.google.com/apis/library/searchconsole.googleapis.com", "Google Search Console API")} for that project and select ${b("Enable")}.`,
			`Create a service account: ${link("https://console.cloud.google.com/iam-admin/serviceaccounts/create", "IAM &amp; Admin → Service Accounts → Create service account")}.${bullets([
				`Name it, for example ${code("coywolf-pack-search-console")}.`,
				"Skip the optional roles (Search Console access comes from step 5).",
				`Select ${b("Done")}.`,
			])}`,
			`Open the new service account and make its key (if Google says key creation is turned off by an organization policy, iam.disableServiceAccountKeyCreation, an organization admin has to allow it for this project):${bullets([
				`Go to ${b("Keys → Add key → Create new key")}.`,
				`Choose ${b("JSON")}.`,
				`Select ${b("Create")}. A .json file downloads.`,
			])}`,
			`Copy the service account's email (it ends in ${code(".iam.gserviceaccount.com")}). In ${link("https://search.google.com/search-console", "Search Console")}, pick the site's property, then ${b("Settings → Users and permissions → Add user")} (the same for a domain property, sc-domain:example.com, and a URL-prefix property):${bullets([
				"Paste the email.",
				`Choose ${b("Restricted")} permission (enough to read performance data).`,
				`Select ${b("Add")}.`,
			])}`,
			`On this page, paste the whole contents of the .json file into ${b("Service account key")} and save. It's stored encrypted, and only the email is shown afterward. Leave ${b("Property")} empty to use the property the service account can see for this site, or enter it: ${code("sc-domain:example.com")} or ${code("https://example.com/")}.`,
			"Delete the downloaded .json file from your computer once it's saved.",
		],
		note: "The pack asks only for read access (the webmasters.readonly scope). Search Console's numbers lag by a day or two, and the newest day may still change. Each reading is three small queries, kept for six hours.",
	},
	"media-host": {
		summary: "How to set up a media host by hand in the Cloudflare dashboard",
		steps: [
			`Find the R2 bucket bound as ${code("MEDIA")} in your site's ${code("wrangler.jsonc")} (its ${code("bucket_name")}). The media host serves that bucket, at a subdomain of the site's own domain, such as ${code("media.example.com")}.`,
			`Turn on Image Transformations: ${link("https://dash.cloudflare.com/?to=/:account/images/transformations", "Cloudflare dashboard → Images → Transformations")}, find the site's domain and select ${b("Enable for zone")}. Leave ${b("Resize images from any origin")} off: the media host is on the same domain.`,
			`Connect the domain to the bucket (Cloudflare adds the DNS record; the certificate takes a few minutes): ${link("https://dash.cloudflare.com/?to=/:account/r2/overview", "R2")} → the media bucket → ${b("Settings → Custom Domains → Add")}, then:${bullets([
				`Enter ${code("media.example.com")}.`,
				"Set the minimum TLS version to 1.2.",
				"Confirm.",
			])}`,
			`Add the first URL rewrite rule: the site's domain → ${b("Rules → Overview → Create rule → URL Rewrite Rule")}, then:${bullets([
				`Name it ${code("media.example.com: /s/&lt;W&gt;x&lt;H&gt;/&lt;file&gt; → cropped resize (Coywolf Pack clean image URLs)")}.`,
				`Choose ${b("Custom filter expression → Edit expression")} and enter ${code('(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*x*/*")')}.`,
				`Under Path, choose ${b("Rewrite to… → Dynamic")} and enter ${code('wildcard_replace(http.request.uri.path, "/s/*x*/*", "/cdn-cgi/image/width=${1},height=${2},fit=cover,format=auto,quality=85/${3}")')}.`,
				"Leave Query as is and deploy.",
			])}`,
			`Add the second rule the same way:${bullets([
				`Name it ${code("media.example.com: /s/&lt;W&gt;/&lt;file&gt; → resize to width (Coywolf Pack clean image URLs)")}.`,
				`The expression: ${code('(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*/*" and not http.request.uri.path wildcard "/s/*x*/*")')}.`,
				`The dynamic path: ${code('wildcard_replace(http.request.uri.path, "/s/*/*", "/cdn-cgi/image/width=${1},format=auto,quality=85/${2}")')}.`,
				"Deploy it.",
			])}`,
			`Turn on Smart Tiered Cache (free): the site's domain → ${b("Caching → Tiered Cache")} → ${b("Smart Tiered Caching")}. A data center that hasn't cached an image yet then asks a nearby Cloudflare cache instead of going back to R2.`,
			`Use your own host name in place of ${code("media.example.com")} everywhere (keep the names exactly as shown otherwise: Set up media host recognizes its rules by name).`,
			`Enter the host as the Media host on this page and select ${b("Check")}. When every check passes, save. Or set it in ${code("astro.config.mjs")}: ${code('coywolfPlugin({ images: { cdn: "https://media.example.com" } })')}.`,
		],
		note: "Cloudflare's Free plan includes 5,000 unique image transformations a month (each new size of each image counts once a month). Beyond that, transformations need a paid Cloudflare Images plan.",
	},
	"backups-token": featureGuide({
		summary: "How Retention on Cloudflare uses the Cloudflare API token",
		before: [
			`The pack finds the backup bucket itself: the ${code("bucket_name")} next to ${code('"binding": "BACKUPS"')} in the site's ${code("wrangler.jsonc")}, shown as ${b("Found")}. If the card says it couldn't, enter that name as Backup bucket name (or find it in the ${link("https://dash.cloudflare.com/?to=/:account/r2/overview", "Cloudflare dashboard → R2")}). Either way, the check makes sure it's the bucket this site writes to.`,
		],
		needs: ["r2", "workersMetadata"],
		note: `Workers → Metadata Read-Only only finds the bucket name; a token without it works once the name is entered. Restores don't use this token: they keep their own (the ${code("BACKUPS_API_TOKEN")} Worker secret, with D1 → Edit). The older retention token, and that Worker secret when it has Workers R2 Storage → Edit, keep working until the Cloudflare API token is saved.`,
	}),
	"backups-retention": {
		summary: "How to set the retention rule by hand in the Cloudflare dashboard",
		steps: [
			`Open ${link("https://dash.cloudflare.com/?to=/:account/r2/overview", "Cloudflare dashboard → R2")} and select the backup bucket (the ${code("bucket_name")} of ${code("BACKUPS")} in ${code("wrangler.jsonc")}).`,
			`Go to ${b("Settings → Object lifecycle rules → Add rule")}. Add three rules, one per prefix:${bullets([
				`${code("coywolf-pack-backups-retention:d1/")} for the prefix ${code("d1/")}`,
				`${code("coywolf-pack-backups-retention:media/changed/")} for the prefix ${code("media/changed/")}`,
				`${code("coywolf-pack-backups-retention:uploads/changed/")} for the prefix ${code("uploads/changed/")}`,
			])}`,
			`For each rule:${bullets([
				"Enter its name.",
				`Choose ${b("Apply to objects with a prefix")} and enter its prefix.`,
				`Turn on ${b("Expire objects")} after the retention days (the number in Keep backups for).`,
				"Save.",
			])}`,
			`Never add a rule for ${code("media/current/")} or ${code("uploads/current/")}, or for the whole bucket: those are the mirrors of your live files.`,
			`Come back to this page and select ${b("Check")}. With the three rules found, the pack stops deleting old backups itself.`,
		],
		note: "Keep the bucket's default rule that aborts incomplete multipart uploads after 7 days. A bucket lock is set the same way under Settings → Bucket lock rules; read the warning on this page first.",
	},
	"images-token": featureGuide({
		summary: "How Set up media host uses the Cloudflare API token",
		needs: ["zone", "zoneSettings", "transformRules", "dns", "r2", "rulesets", "workersMetadata"],
		note: `Workers → Metadata Read-Only only finds the media bucket's name (bound as ${code("MEDIA")} in ${code("wrangler.jsonc")}); a token without it works once the name is entered. Clearing the media host's images needs ${b(CLOUDFLARE_PERMISSIONS.cachePurge.name)} too, and its cache rule (Performance page) ${b(CLOUDFLARE_PERMISSIONS.cacheRules.name)}. In Cloudflare's token editor, search for “cache”: both rows are under Cache &amp; Performance, one named just Cache and one named Cache Settings. The token is only sent to api.cloudflare.com. The older Clean Image URLs token and ${code("IMAGES_API_TOKEN")} Worker secret keep working until the Cloudflare API token is saved.`,
	}),
	"browser-run-token": featureGuide({
		summary: "How Social Images uses the Cloudflare API token",
		needs: ["browserRun"],
		note: `The token is used only with api.cloudflare.com, to take a screenshot of the image template. Browser Run includes 10 minutes of browser time a day on Workers Free and 10 hours a month on Workers Paid; one image takes a second or two. Or skip the token: add ${code('"browser": { "binding": "BROWSER" }')} to the site's ${code("wrangler.jsonc")} (with ${code("compatibility_date")} 2026-03-24 or later). The older Social Images token and ${code("BROWSER_RUN_API_TOKEN")} Worker secret keep working until the Cloudflare API token is saved.`,
	}),
};

/**
 * What the generic Settings page shows for each secret once enhanced: a short
 * plain description, then the guides (closed). Keys match SECRET_SETTINGS.
 */
export const SETTINGS_PAGE_GUIDES: Record<string, { intro: string; guides: GuideId[] }> = {
	cloudflareApiToken: {
		intro: "One token for every Cloudflare feature: usage, Insights, Checkup, Clean Image URLs, Videos, Backups retention, Social Images, the Radar crawler list and large uploads. Or set the CLOUDFLARE_API_TOKEN Worker secret.",
		guides: ["cloudflare-token"],
	},
	aiApiKey: {
		intro: "For Anthropic, OpenAI or Gemini (Workers AI needs no key). The provider and model are on the AI Enrichment page.",
		guides: ["anthropic", "openai", "gemini"],
	},
	insightsFathomApiKey: {
		intro: "For the Fathom card on the Insights page, where the site ID goes.",
		guides: ["fathom"],
	},
	insightsGoogleServiceAccount: {
		intro: "For the Search Console card on the Insights page. Paste the whole JSON key file.",
		guides: ["search-console"],
	},
};

/**
 * A guide as a closed <details> (HTML), styled with the admin's own classes. Steps and notes may hold child lists
 * (bullets()), so the note is a <div> (a <ul> can't sit in a <p>).
 */
export function guideHtml(guide: Guide): string {
	const steps = guide.steps.map((s) => `<li>${s}</li>`).join("");
	return `<details class="rounded-md border border-kumo-line text-sm"><summary class="cursor-pointer px-3 py-2 font-medium" style="display:list-item">${guide.summary}</summary><div class="space-y-2 border-t border-kumo-line px-3 py-3"><ol class="space-y-1.5" style="list-style:decimal;padding-inline-start:1.25rem">${steps}</ol>${
		guide.note ? `<div class="space-y-1 text-xs text-kumo-subtle">${guide.note}</div>` : ""
	}</div></details>`;
}

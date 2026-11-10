/**
 * Insights: the feature switches, settings keys and deadlines its parts share.
 *
 * Kept free of imports so tests can load it directly.
 */

export const INSIGHTS_FEATURES = {
	main: "insights",
	edge: "insights.edge",
	vitals: "insights.vitals",
	beacon: "insights.beacon",
	fathom: "insights.fathom",
	searchConsole: "insights.searchConsole",
	search: "insights.search",
} as const;

/**
 * Plain settings (edited on the Insights page) and the two secrets, which are
 * declared in src/core/secrets.ts so EmDash encrypts them.
 */
export const INSIGHTS_SETTINGS = {
	/** Cloudflare Web Analytics site token: public (it's in every page's beacon), so a plain setting. */
	beaconToken: "insightsBeaconToken",
	fathomSiteId: "insightsFathomSiteId",
	/** Secret. */
	fathomKey: "insightsFathomApiKey",
	/** "sc-domain:example.com" or "https://example.com/"; empty: found from the properties the service account can see. */
	searchConsoleProperty: "insightsSearchConsoleProperty",
	/** Secret: the service account's JSON key, kept as client_email, private_key, private_key_id and project_id. */
	googleKey: "insightsGoogleServiceAccount",
} as const;

/** Every external call has a deadline (a call past it is aborted and the card says so). */
export const INSIGHTS_DEADLINES = {
	/** One Cloudflare API or GraphQL call: a 30-day grouped query over HTTP requests can take a few seconds. */
	cloudflareMs: 20_000,
	/** One Fathom aggregation (Fathom says a first unique aggregation can take a moment). */
	fathomMs: 15_000,
	/** Google's token exchange or one Search Analytics query. */
	googleMs: 15_000,
	/** How long a page load waits for a reading another request started (several calls in a row). */
	sharedWaitMs: 45_000,
} as const;

/** External hosts the parts call (the plugin's allowedHosts; api.cloudflare.com is already there). */
export const INSIGHTS_HOSTS = ["api.usefathom.com", "oauth2.googleapis.com", "www.googleapis.com"] as const;

/**
 * Buttondown Drafts: the feature switches, settings keys, host, deadlines and
 * names its parts share.
 *
 * Kept free of imports so tests can load it directly.
 */

export const BUTTONDOWN_FEATURES = {
	main: "buttondown",
	/** Update the draft when its post is published again (while it's an untouched draft in Buttondown). */
	updates: "buttondown.updates",
} as const;

/** Plain settings (rules, footer link), edited on the module's page and read with the feature switches. */
export const BUTTONDOWN_SETTINGS_KEY = "buttondownSettings";
/** The secret: declared in src/core/secrets.ts, saved on the plugin's Settings page like the other keys. */
export const BUTTONDOWN_KEY_SETTING = "buttondownApiKey";

/** The one host the module calls (also the plugin's allowedHosts entry). */
export const BUTTONDOWN_HOST = "api.buttondown.com";
export const BUTTONDOWN_API = `https://${BUTTONDOWN_HOST}/v1`;
/** Where a draft opens in Buttondown's app (https://buttondown.com/emails/<id>). Only ever a link the admin shows. */
export const BUTTONDOWN_APP = "https://buttondown.com";

/** Plugin storage: one record per entry ("<collection>:<entry id>"). */
export const BUTTONDOWN_STORAGE = "buttondownEmails";
export const BUTTONDOWN_TASK = "buttondown-retry";

export const BUTTONDOWN_LIMITS = {
	/** One call to Buttondown's API (the answer's body included). */
	callMs: 8_000,
	/** A background job after a publish (EmDash's waitUntil allows 30 seconds after the response). */
	jobMs: 25_000,
	/** The longest Retry-After a job waits for in place before leaving the retry to the hourly task. */
	retryAfterWaitMs: 10_000,
	/** A claim older than this is taken over (its job was cut off). */
	claimStaleMs: 2 * 60_000,
	/** A pending or creating record older than this is the hourly task's to finish. */
	stuckMs: 5 * 60_000,
	/** Records the hourly task retries per run. */
	retriesPerRun: 5,
	/** Pages of the draft list read when looking for a draft the Pack already made. */
	lookupPages: 3,
	/** Kept this long, then pruned, once they're done (left, gone, stopped, removed). */
	pruneAfterMs: 180 * 86_400_000,
	/** Rules per site. */
	rules: 10,
	/** Terms per rule. */
	terms: 50,
	/** Buttondown's error detail, as stored and shown. */
	detailChars: 300,
	/** Width of images in the email (resized on the media host). */
	imageWidth: 1200,
	/** A record in error this long is reported by Alerts (buttondownFailed). */
	alertAfterMs: 60 * 60_000,
} as const;

/** Backoff after a temporary failure (5xx, network, timeout): 5 min, 15 min, 1 h, 3 h, 6 h, then every 6 h for up to 3 days. */
export const BUTTONDOWN_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000] as const;
export const BUTTONDOWN_RETRY_FOR_MS = 3 * 86_400_000;

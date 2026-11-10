/**
 * Cloudflare Checkup: the zone settings that matter for an EmDash site served
 * by a Worker, each with what it does in plain words, what it's set to, and
 * what to do. Pure: it turns what was read from Cloudflare's API (./zone.ts)
 * into rows, and describes the few one-click fixes the page offers.
 *
 * Every zone setting is zone-wide: it applies to every hostname in the zone,
 * which on some zones includes apps besides the site (the rows and fixes say
 * so). HSTS is only ever recommended, never set by the pack: browsers
 * remember it, so it's hard to undo.
 *
 * Kept free of imports so tests can load it directly.
 */

export type RowStatus = "good" | "warn" | "info" | "unknown";
export type RowGroup = "speed" | "https" | "html" | "bots";

export type FixId = "speed-brain-off" | "always-use-https-on" | "min-tls-1.2";

export interface CheckupRow {
	id: string;
	group: RowGroup;
	label: string;
	/** What it's set to, in words ("On", "TLS 1.0"); null when it couldn't be read. */
	value: string | null;
	status: RowStatus;
	/** What the setting does. */
	explanation: string;
	/** What to do on a Workers-served EmDash site. */
	recommendation: string;
	/** The setting's page in the Cloudflare dashboard. */
	dashboardUrl: string;
	/** A setting of the zone (every hostname in it), not of this site alone. */
	zoneWide: boolean;
	/** The one-click fix the page offers (with the setup token) while the row needs it. */
	fix?: FixId;
	/** Something to read before changing it. */
	caution?: string;
	/** A page of the pack's docs ("cloudflare-checkup#tracking-parameters"). */
	docs?: string;
	/** A step-by-step guide shown in the row (src/core/guide-content.ts). */
	guide?: "tracking-params";
}

export interface CheckupZone {
	id: string;
	name: string;
	accountId: string | null;
}

/** A zone setting as GET /zones/{id}/settings returns it. */
export interface ZoneSetting {
	id: string;
	value: unknown;
	editable?: boolean;
}

/** The fields of GET /zones/{id}/bot_management the checkup reads. */
export interface BotSettings {
	fight_mode?: boolean;
	ai_bots_protection?: string;
	crawler_protection?: string;
	is_robots_txt_managed?: boolean;
}

export interface CheckupInput {
	zone: CheckupZone | null;
	/** Zone settings by id; null when they couldn't be read (settingsProblem says why). */
	settings: Map<string, unknown> | null;
	settingsProblem?: string;
	/** null when they couldn't be read (botsProblem says why). */
	bots: BotSettings | null;
	botsProblem?: string;
	/** Crawler Hints: true/false, or null when it couldn't be read. */
	crawlerHints: boolean | null;
	crawlerHintsProblem?: string;
	/** The site's Worker is wrapped with stripTrackingParams (its src/worker.ts). */
	trackingWrapper: boolean;
	/** What the wrapper last recorded (src/core/tracking-params.ts TrackingState); null before the first tracked request. */
	trackingState?: { at: string; loopback: boolean; status?: number; cache?: string | null } | null;
	/** The pack's Speculation Rules switch. */
	speculationOn: boolean;
	/** The pack's Robots.txt Rules switch. */
	robotsOn: boolean;
}

/** A page of the site's zone in the Cloudflare dashboard (with the account and zone when known). */
export function dashboardUrl(zone: CheckupZone | null, page: string): string {
	if (zone?.accountId) return `https://dash.cloudflare.com/${encodeURIComponent(zone.accountId)}/${encodeURIComponent(zone.name)}/${page}`;
	// The dashboard asks for the account and the zone, then opens the page.
	return `https://dash.cloudflare.com/?to=/:account/:zone/${page}`;
}

const PAGES = {
	speed: "speed/optimization",
	caching: "caching/configuration",
	edge: "ssl-tls/edge-certificates",
	security: "security/settings",
} as const;

const onOff = (value: unknown): boolean | null => (value === "on" ? true : value === "off" ? false : null);
const word = (on: boolean | null) => (on === null ? null : on ? "On" : "Off");

/** TLS versions in order, for comparing min_tls_version. */
const TLS_ORDER = ["1.0", "1.1", "1.2", "1.3"];
export const tlsAtLeast = (value: unknown, floor: string) => typeof value === "string" && TLS_ORDER.indexOf(value) >= TLS_ORDER.indexOf(floor) && TLS_ORDER.includes(value);

export interface HstsValue {
	enabled?: boolean;
	max_age?: number;
	include_subdomains?: boolean;
	preload?: boolean;
	nosniff?: boolean;
}

export function hstsOf(value: unknown): HstsValue | null {
	const sts = (value as { strict_transport_security?: HstsValue } | null)?.strict_transport_security;
	return sts && typeof sts === "object" ? sts : null;
}

const days = (seconds: number) => {
	const d = Math.round(seconds / 86_400);
	return d >= 365 && d % 365 === 0 ? `${d / 365} year${d === 365 ? "" : "s"}` : `${d} day${d === 1 ? "" : "s"}`;
};

/**
 * The one-click fixes. Each changes one zone setting to one value, only when
 * it isn't already there (so pressing it twice changes nothing), and is
 * zone-wide.
 */
export const FIXES: Record<FixId, { setting: string; target: string; targetLabel: string; title: string; button: string; needed: (current: unknown) => boolean; change: (current: unknown) => string; effect: string }> = {
	"speed-brain-off": {
		setting: "speed_brain",
		targetLabel: "Off",
		target: "off",
		title: "Turn off Speed Brain",
		button: "Turn off Speed Brain",
		needed: (current) => current === "on",
		change: (current) => `Speed Brain (speed_brain) from ${String(current ?? "unknown")} to off`,
		effect:
			"Cloudflare stops adding its Speculation-Rules header to pages. It never prefetched this site's pages (they're served by a Worker), but on a hostname in the zone that isn't served by a Worker, it did: that hostname loses Cloudflare's prefetching.",
	},
	"always-use-https-on": {
		setting: "always_use_https",
		targetLabel: "On",
		target: "on",
		title: "Turn on Always Use HTTPS",
		button: "Turn on Always Use HTTPS",
		needed: (current) => current !== "on",
		change: (current) => `Always Use HTTPS (always_use_https) from ${String(current ?? "unknown")} to on`,
		effect:
			"Cloudflare answers every http:// request with a redirect to https://, for every hostname in the zone. Check first that each of them works over HTTPS: a hostname without a certificate at Cloudflare (a sub-subdomain such as a.b.example.com on the free certificate) or an old client that only speaks http:// would stop working.",
	},
	"min-tls-1.2": {
		setting: "min_tls_version",
		targetLabel: "TLS 1.2",
		target: "1.2",
		title: "Set the minimum TLS version to 1.2",
		button: "Require TLS 1.2",
		needed: (current) => !tlsAtLeast(current, "1.2"),
		change: (current) => `Minimum TLS Version (min_tls_version) from ${String(current ?? "unknown")} to 1.2`,
		effect:
			"Browsers and apps that only support TLS 1.0 or 1.1 (from before 2014, such as Android 4.3 or Internet Explorer 10) can no longer connect to any hostname in the zone. Every current browser and HTTP library supports TLS 1.2.",
	},
};

export const isFixId = (value: unknown): value is FixId => typeof value === "string" && Object.hasOwn(FIXES, value);

/**
 * The tracking-parameter row: installed or not, and what the wrapper has seen.
 * "Removed before the cache" only once a request with tracking parameters was
 * served from the cache (a HIT on the call through it).
 */
export function trackingRow(installed: boolean, state: CheckupInput["trackingState"] | null): Pick<CheckupRow, "label" | "value" | "status" | "recommendation" | "guide"> {
	const label = "Tracking parameters";
	if (!installed) {
		return {
			label,
			value: "Each one is its own cache entry",
			guide: "tracking-params",
			status: "info",
			recommendation:
				"Cloudflare's docs say zone rules that change the request (URL Rewrite Rules) don't apply to Workers Cache, so this can't be a setup button. It's a short change to the site's src/worker.ts: see the docs.",
		};
	}
	const seen = state?.at ? ` (last seen ${state.at.slice(0, 16).replace("T", " ")} UTC)` : "";
	if (!state) {
		return {
			label,
			value: "Installed, waiting for the first tracked visit",
			status: "info",
			recommendation: "The Worker is wrapped, but no link with tracking parameters has reached it yet. Open the site with ?utm_source=test twice (the docs' first rollout step), then check again.",
		};
	}
	if (!state.loopback) {
		return {
			label,
			value: "Installed, but the Worker can't call itself",
			status: "warn",
			recommendation: `Requests are served as they come${seen}. Set the compatibility date in wrangler.jsonc to 2025-11-17 or later (or add the enable_ctx_exports flag), or add a SELF service binding, and deploy.`,
		};
	}
	if (String(state.cache).toUpperCase() === "HIT") {
		return {
			label,
			value: "Removed before the cache",
			status: "good",
			recommendation: `Links with tracking parameters are served from the cached page${seen}. Analytics still see the parameters: they read the address bar.`,
		};
	}
	return {
		label,
		value: "Installed, no cache hit seen yet",
		status: "info",
		recommendation: `The Worker calls itself without the parameters, but that call hasn't come from the cache yet (cf-cache-status: ${state.cache ?? "none"}${seen}). Open the same link twice; if the second visit isn't a HIT either, see the docs.`,
	};
}

/** The checkup's rows, in the order the page shows them. */
export function checkupRows(input: CheckupInput): CheckupRow[] {
	const z = input.zone;
	const s = input.settings;
	const get = (id: string) => (s ? s.get(id) : undefined);
	const unread = (id: string) => !s || !s.has(id);
	const rows: CheckupRow[] = [];
	const unknownValue = "Couldn't read it";

	// ── Speed ──
	const speedBrain = onOff(get("speed_brain"));
	rows.push({
		id: "speed_brain",
		group: "speed",
		label: "Speed Brain",
		value: unread("speed_brain") ? null : word(speedBrain),
		status: unread("speed_brain") ? "unknown" : speedBrain ? "warn" : "good",
		explanation:
			"Cloudflare's own prefetching: it tells browsers to fetch the next page early. Cloudflare's docs say it won't prefetch pages served by a Worker, which is every page of this site, so here it only adds a header and a request for its rules file.",
		recommendation: speedBrain
			? `Turn it off${input.speculationOn ? "" : " and turn on the pack's Speculation Rules (Performance page), which does prefetch these pages, from the edge cache"}.`
			: input.speculationOn
				? "Off, and the pack's Speculation Rules does the prefetching. Nothing to do."
				: "Off. For prefetching, turn on the pack's Speculation Rules (Performance page).",
		dashboardUrl: dashboardUrl(z, PAGES.speed),
		zoneWide: true,
		...(speedBrain ? { fix: "speed-brain-off" as const } : {}),
	});

	rows.push({
		id: "tracking_params",
		group: "speed",
		...trackingRow(input.trackingWrapper, input.trackingState ?? null),
		explanation:
			"Links with utm_source, fbclid, gclid and similar parameters are different addresses to Workers Cache, so campaign, newsletter and social visitors get a page built for them (about 250 ms) instead of the cached one (60–90 ms). Click IDs are unique per click, so those visitors always do.",
		dashboardUrl: "https://developers.cloudflare.com/workers/cache/cache-keys/",
		zoneWide: false,
		docs: "cloudflare-checkup#tracking-parameters",
	});

	const crawlerHints = input.crawlerHints;
	rows.push({
		id: "crawler_hints",
		group: "speed",
		label: "Crawler Hints",
		value: crawlerHints === null ? null : word(crawlerHints),
		status: crawlerHints === null ? "unknown" : crawlerHints ? "good" : "warn",
		explanation:
			"Cloudflare tells Bing and the other IndexNow search engines when a page has likely changed, from its own systems (pings from Workers are throttled).",
		recommendation: crawlerHints === false ? "Turn it on in the dashboard (Caching → Configuration). Cloudflare doesn't let API tokens switch it." : crawlerHints ? "On. Nothing to do." : (input.crawlerHintsProblem ?? unknownValue),
		dashboardUrl: dashboardUrl(z, PAGES.caching),
		zoneWide: true,
	});

	const earlyHints = onOff(get("early_hints"));
	rows.push({
		id: "early_hints",
		group: "speed",
		label: "Early Hints",
		value: unread("early_hints") ? null : word(earlyHints),
		status: unread("early_hints") ? "unknown" : earlyHints ? "good" : "info",
		explanation:
			"Cloudflare sends the browser a page's Link headers (such as the pack's early connection to the media host) before the page itself, so it can start on them sooner.",
		recommendation: earlyHints
			? "On. Nothing to do."
			: "Optional and low risk: turn it on in the dashboard. Cached pages already answer in 60–90 ms, so the gain is small.",
		dashboardUrl: dashboardUrl(z, PAGES.speed),
		zoneWide: true,
	});

	const http3 = onOff(get("http3"));
	rows.push({
		id: "http3",
		group: "speed",
		label: "HTTP/3",
		value: unread("http3") ? null : word(http3),
		status: unread("http3") ? "unknown" : http3 ? "good" : "warn",
		explanation: "The newest version of HTTP, over QUIC. Connections start faster and cope better with patchy mobile networks.",
		recommendation: http3 ? "On. Nothing to do." : "Turn it on in the dashboard (Speed → Settings → Protocol Optimization). It's free and browsers fall back to HTTP/2 on their own.",
		dashboardUrl: dashboardUrl(z, PAGES.speed),
		zoneWide: true,
	});

	// ── HTTPS ──
	const alwaysHttps = onOff(get("always_use_https"));
	rows.push({
		id: "always_use_https",
		group: "https",
		label: "Always Use HTTPS",
		value: unread("always_use_https") ? null : word(alwaysHttps),
		status: unread("always_use_https") ? "unknown" : alwaysHttps ? "good" : "warn",
		explanation: "Cloudflare redirects http:// requests to https:// before they reach the site.",
		recommendation: alwaysHttps ? "On. Nothing to do." : "Turn it on, once every hostname in the zone works over HTTPS.",
		dashboardUrl: dashboardUrl(z, PAGES.edge),
		zoneWide: true,
		...(alwaysHttps === false ? { fix: "always-use-https-on" as const } : {}),
	});

	const minTls = get("min_tls_version");
	const tlsOk = tlsAtLeast(minTls, "1.2");
	rows.push({
		id: "min_tls_version",
		group: "https",
		label: "Minimum TLS version",
		value: unread("min_tls_version") ? null : `TLS ${String(minTls)}`,
		status: unread("min_tls_version") ? "unknown" : tlsOk ? "good" : "warn",
		explanation: "The oldest encryption version a visitor's browser may use to connect. TLS 1.0 and 1.1 have known weaknesses and browsers dropped them in 2020.",
		recommendation: tlsOk ? "TLS 1.2 or newer. Nothing to do." : "Require TLS 1.2. Every current browser supports it.",
		dashboardUrl: dashboardUrl(z, PAGES.edge),
		zoneWide: true,
		...(!unread("min_tls_version") && !tlsOk ? { fix: "min-tls-1.2" as const } : {}),
	});

	const tls13 = get("tls_1_3");
	const tls13On = tls13 === "on" || tls13 === "zrt";
	rows.push({
		id: "tls_1_3",
		group: "https",
		label: "TLS 1.3",
		value: unread("tls_1_3") ? null : tls13On ? "On" : "Off",
		status: unread("tls_1_3") ? "unknown" : tls13On ? "good" : "warn",
		explanation: "The newest encryption version: connections are set up in one round trip instead of two, and it's the most secure.",
		recommendation: tls13On ? "On. Nothing to do." : "Turn it on in the dashboard (SSL/TLS → Edge Certificates). Browsers that don't support it keep using TLS 1.2.",
		dashboardUrl: dashboardUrl(z, PAGES.edge),
		zoneWide: true,
	});

	const hsts = hstsOf(get("security_header"));
	const hstsOn = hsts?.enabled === true;
	rows.push({
		id: "hsts",
		group: "https",
		label: "HSTS (HTTP Strict Transport Security)",
		value: unread("security_header") ? null : hstsOn ? `On, ${days(hsts?.max_age ?? 0)}${hsts?.include_subdomains ? ", subdomains included" : ""}${hsts?.preload ? ", preload" : ""}` : "Off",
		status: unread("security_header") ? "unknown" : hstsOn ? "good" : "info",
		explanation:
			"Tells browsers to use only https:// for the site from then on, for as long as the max-age says, which saves the redirect and stops downgrade attacks.",
		recommendation: hstsOn
			? "On. Keep Always Use HTTPS on too."
			: "Recommended, but only in the dashboard and only once everything works over HTTPS. Start with a max-age of 1 day, without Include subdomains or Preload, then raise it.",
		caution:
			"Hard to undo: a browser that has seen it refuses http:// until the max-age runs out, even if you turn it off. Include subdomains covers every subdomain in the zone, apps included, and Preload puts the domain in browsers' built-in lists, which takes months to leave. The pack never turns it on.",
		dashboardUrl: dashboardUrl(z, PAGES.edge),
		zoneWide: true,
	});

	// ── Features that rewrite pages ──
	const rocket = onOff(get("rocket_loader"));
	rows.push({
		id: "rocket_loader",
		group: "html",
		label: "Rocket Loader",
		value: unread("rocket_loader") ? null : word(rocket),
		status: unread("rocket_loader") ? "unknown" : rocket ? "warn" : "good",
		explanation: "Rewrites a page's script tags so scripts load after the page. It can run scripts in a different order than the page asks, which breaks some scripts and analytics.",
		recommendation: rocket ? "Turn it off in the dashboard (Speed → Settings → Content Optimization). EmDash themes already load their scripts without blocking the page." : "Off. Nothing to do.",
		dashboardUrl: dashboardUrl(z, PAGES.speed),
		zoneWide: true,
	});

	const email = onOff(get("email_obfuscation"));
	rows.push({
		id: "email_obfuscation",
		group: "html",
		label: "Email Address Obfuscation",
		value: unread("email_obfuscation") ? null : word(email),
		status: unread("email_obfuscation") ? "unknown" : email ? "info" : "good",
		explanation:
			"Hides email addresses in a page from scrapers by rewriting them and adding a script (email-decode.min.js). Cloudflare's docs say it doesn't touch HTML a Worker adds, so on this site it likely does nothing.",
		recommendation: email ? "Off is simplest: nothing then rewrites the pages the Worker sends. Leave it on if another hostname in the zone relies on it." : "Off. Nothing to do.",
		dashboardUrl: dashboardUrl(z, PAGES.security),
		zoneWide: true,
	});

	const rewrites = onOff(get("automatic_https_rewrites"));
	rows.push({
		id: "automatic_https_rewrites",
		group: "html",
		label: "Automatic HTTPS Rewrites",
		value: unread("automatic_https_rewrites") ? null : word(rewrites),
		status: unread("automatic_https_rewrites") ? "unknown" : "info",
		explanation: "Rewrites http:// links and images in a page to https:// when that address works over HTTPS, so old content doesn't trigger mixed-content warnings.",
		recommendation: rewrites
			? "Fine either way. It helps content imported from WordPress with http:// links; once your links use https:// (Link Manager lists them), it has nothing left to do."
			: "Off. If pages show mixed-content warnings, fix the http:// links (Link Manager lists them) or turn it on.",
		dashboardUrl: dashboardUrl(z, PAGES.edge),
		zoneWide: true,
	});

	// ── Bots ──
	const b = input.bots;
	const botUnknown = b === null;
	const fight = b?.fight_mode === true;
	rows.push({
		id: "bot_fight_mode",
		group: "bots",
		label: "Bot Fight Mode",
		value: botUnknown ? null : word(fight),
		status: botUnknown ? "unknown" : fight ? "warn" : "good",
		explanation:
			"Challenges traffic Cloudflare thinks is automated. On the Free plan no rule can make an exception, so it can also stop feed readers, link checkers, uptime monitors and other tools that your robots.txt allows.",
		recommendation: botUnknown ? (input.botsProblem ?? unknownValue) : fight ? "Turn it off unless the site is under attack; block what you don't want with Robots.txt Rules or WAF custom rules instead." : "Off. Nothing to do.",
		dashboardUrl: dashboardUrl(z, PAGES.security),
		zoneWide: true,
	});

	const aiBlock = b?.ai_bots_protection === "block" || b?.ai_bots_protection === "only_on_ad_pages";
	rows.push({
		id: "ai_bots",
		group: "bots",
		label: "Block AI bots",
		value: botUnknown ? null : b?.ai_bots_protection === "only_on_ad_pages" ? "On (pages with ads)" : word(aiBlock),
		status: botUnknown ? "unknown" : aiBlock && input.robotsOn ? "warn" : "info",
		explanation: "Cloudflare blocks known AI crawlers at its edge, whatever the site's robots.txt says.",
		recommendation: botUnknown
			? (input.botsProblem ?? unknownValue)
			: aiBlock
				? input.robotsOn
					? "Robots.txt Rules may allow AI crawlers that Cloudflare blocks anyway. Decide in one place: here, or in Robots.txt Rules (and turn this off)."
					: "On: AI crawlers are blocked at the edge. That's a choice, not a problem."
				: "Off: AI crawlers follow what robots.txt says.",
		dashboardUrl: dashboardUrl(z, PAGES.security),
		zoneWide: true,
	});

	const managed = b?.is_robots_txt_managed === true;
	rows.push({
		id: "managed_robots",
		group: "bots",
		label: "Cloudflare-managed robots.txt",
		value: botUnknown ? null : word(managed),
		status: botUnknown ? "unknown" : managed ? "warn" : "good",
		explanation: "Cloudflare adds its own lines (AI crawler rules) to the top of the site's robots.txt.",
		recommendation: botUnknown
			? (input.botsProblem ?? unknownValue)
			: managed
				? "Turn it off: robots.txt then has one author (Robots.txt Rules, or EmDash's Settings → SEO), and two sets of rules can't contradict each other."
				: "Off: robots.txt is exactly what the site serves.",
		dashboardUrl: dashboardUrl(z, PAGES.security),
		zoneWide: true,
	});

	const labyrinth = b?.crawler_protection === "enabled";
	rows.push({
		id: "ai_labyrinth",
		group: "bots",
		label: "AI Labyrinth",
		value: botUnknown ? null : word(labyrinth),
		status: botUnknown ? "unknown" : "info",
		explanation: "Shows AI crawlers that ignore robots.txt a maze of generated pages, linked so people don't see them. Crawlers that follow robots.txt never see it.",
		recommendation: botUnknown ? (input.botsProblem ?? unknownValue) : "Either way is fine: it only affects crawlers that ignore robots.txt.",
		dashboardUrl: dashboardUrl(z, PAGES.security),
		zoneWide: true,
	});

	return rows;
}

/** The settings the rows read (and the fixes change), for reading them one by one when the bulk read leaves any out. */
export const CHECKUP_SETTINGS = ["speed_brain", "early_hints", "http3", "always_use_https", "min_tls_version", "tls_1_3", "security_header", "rocket_loader", "email_obfuscation", "automatic_https_rewrites"] as const;

/** Proxied hostnames in the zone other than the site's own (from its DNS records), sorted. */
export function otherHostnames(records: Array<{ name?: string; type?: string; proxied?: boolean }>, siteHost: string): string[] {
	const host = siteHost.toLowerCase();
	const names = records
		.filter((r) => r.proxied === true && typeof r.name === "string" && ["A", "AAAA", "CNAME"].includes(String(r.type)))
		.map((r) => String(r.name).toLowerCase())
		.filter((n) => n !== host);
	return [...new Set(names)].sort();
}

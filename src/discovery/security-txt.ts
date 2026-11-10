/**
 * security.txt (RFC 9116): how security researchers reach the site's owner,
 * served at /.well-known/security.txt from the Discovery settings. The
 * required Expires field is worked out each time the file is built (it's
 * kept at the edge for a day at most), so it's always about a year ahead
 * and the file never goes stale.
 *
 * Kept free of EmDash imports so tests and the admin page can load it.
 */

export const SECURITY_TXT_PATH = "/.well-known/security.txt";
/** The legacy location (RFC 9116 §3): redirected to the one above. */
export const LEGACY_SECURITY_TXT_PATH = "/security.txt";
/** Cache tag of both answers at the edge (cleared when the Discovery settings are saved). */
export const SECURITY_TXT_TAG = "coywolf:security-txt";
/** How long the edge and browsers keep it: a day, so Expires moves forward daily. */
export const SECURITY_TXT_MAX_AGE = 86_400;
/** Expires is this many days after the start of today (UTC): always less than a year ahead, as RFC 9116 recommends. */
export const EXPIRES_DAYS = 364;

export interface SecurityTxtSettings {
	/** Email addresses or https:// / tel: URIs, most preferred first. At least one is required. */
	contacts: string[];
	policy: string;
	/** Comma-separated language tags, e.g. "en, fr". */
	languages: string;
	encryption: string;
	acknowledgments: string;
	hiring: string;
}

export const SECURITY_TXT_DEFAULTS: SecurityTxtSettings = { contacts: [], policy: "", languages: "en", encryption: "", acknowledgments: "", hiring: "" };

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const HTTPS_URL = /^https:\/\/[^\s<>"]+$/i;
const LANGUAGE = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;

/** A contact as RFC 9116 wants it (a bare address becomes mailto:), or null when it isn't one. */
export function contactUri(value: string): string | null {
	const v = value.trim();
	if (!v) return null;
	if (/^mailto:/i.test(v)) return EMAIL.test(v.slice(7)) ? `mailto:${v.slice(7)}` : null;
	if (/^tel:\+?[0-9][0-9\-. ()]{3,30}$/i.test(v)) return `tel:${v.slice(4).replace(/[ ()]/g, "")}`;
	if (HTTPS_URL.test(v)) return v;
	if (EMAIL.test(v)) return `mailto:${v}`;
	return null;
}

const httpsOrEmpty = (value: string) => !value.trim() || HTTPS_URL.test(value.trim());

/** The language tags, cleaned ("en, fr-CA"); invalid ones are dropped. */
export function languageList(value: string): string[] {
	return value
		.split(/[,\s]+/)
		.map((l) => l.trim())
		.filter((l) => LANGUAGE.test(l));
}

/** What's wrong with these settings, in plain words (empty when they can be saved). */
export function securityTxtProblems(s: SecurityTxtSettings): string[] {
	const problems: string[] = [];
	for (const contact of s.contacts) if (contact.trim() && !contactUri(contact)) problems.push(`"${contact}" isn't an email address, an https:// URL or a tel: number.`);
	const fields: Array<[keyof SecurityTxtSettings, string]> = [
		["policy", "The policy"],
		["encryption", "The encryption key"],
		["acknowledgments", "The acknowledgments page"],
		["hiring", "The jobs page"],
	];
	for (const [key, label] of fields) if (!httpsOrEmpty(String(s[key]))) problems.push(`${label} must be an https:// URL.`);
	const invalidLanguages = s.languages.split(/[,\s]+/).filter((l) => l.trim() && !LANGUAGE.test(l.trim()));
	if (invalidLanguages.length) problems.push(`Languages are codes such as en or fr-CA (not ${invalidLanguages.join(", ")}).`);
	return problems;
}

/** The Expires date for a file built at `now`: the start of today (UTC) plus EXPIRES_DAYS, in RFC 3339. */
export function securityTxtExpires(now: number): string {
	const day = new Date(now);
	const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
	return new Date(start + EXPIRES_DAYS * 86_400_000).toISOString().replace(".000Z", "Z");
}

/**
 * The file, or null when there's no valid contact (the only field besides
 * Expires that RFC 9116 requires). `origin` is the site's, for Canonical.
 */
export function buildSecurityTxt(s: SecurityTxtSettings, origin: string, now: number = Date.now()): string | null {
	const contacts = [...new Set(s.contacts.map(contactUri).filter((c): c is string => c !== null))];
	if (!contacts.length) return null;
	const url = (value: string) => (HTTPS_URL.test(value.trim()) ? value.trim() : null);
	const lines = [`# ${new URL(origin).host}: how to report a security problem (RFC 9116).`, ...contacts.map((c) => `Contact: ${c}`), `Expires: ${securityTxtExpires(now)}`];
	const encryption = url(s.encryption);
	if (encryption) lines.push(`Encryption: ${encryption}`);
	const acknowledgments = url(s.acknowledgments);
	if (acknowledgments) lines.push(`Acknowledgments: ${acknowledgments}`);
	const languages = languageList(s.languages);
	if (languages.length) lines.push(`Preferred-Languages: ${languages.join(", ")}`);
	lines.push(`Canonical: ${origin.replace(/\/+$/, "")}${SECURITY_TXT_PATH}`);
	const policy = url(s.policy);
	if (policy) lines.push(`Policy: ${policy}`);
	const hiring = url(s.hiring);
	if (hiring) lines.push(`Hiring: ${hiring}`);
	return `${lines.join("\n")}\n`;
}

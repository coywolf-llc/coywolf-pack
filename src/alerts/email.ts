/**
 * Alerts and digest emails: plain text plus a simple HTML version of the same
 * sections, US English. Pure (no I/O) so tests can load it. Every value that
 * comes from the site (titles, URLs, error messages) is escaped in the HTML.
 */

export interface EmailSection {
	title: string;
	lines: string[];
	/** An admin page with more ("/backups"), linked under the section. */
	page?: string;
	/** Label of that link (default "Open"). */
	pageLabel?: string;
}

export interface BuiltEmail {
	subject: string;
	text: string;
	html: string;
}

const ADMIN_PAGE = "/_emdash/admin/plugins/coywolf-pack";

export function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** An admin page's absolute URL, or null without a site URL. */
export function adminPageUrl(siteUrl: string, page: string): string | null {
	if (!siteUrl) return null;
	try {
		return new URL(`${ADMIN_PAGE}${page.startsWith("/") ? page : `/${page}`}`, siteUrl).href;
	} catch {
		return null;
	}
}

/** One line for a subject: no line breaks, at most 150 characters. */
const oneLine = (text: string, max = 150) => {
	const flat = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The email: a heading, an intro, the sections, then a footer saying why it
 * was sent and where to turn it off.
 */
export function buildEmail(o: { siteName: string; siteUrl: string; subject: string; heading: string; intro: string; sections: EmailSection[]; footer: string }): BuiltEmail {
	const site = o.siteName.trim() || (o.siteUrl ? new URL(o.siteUrl).host : "Your site");
	const subject = oneLine(`${site}: ${o.subject}`);
	const textParts = [o.heading, "", o.intro, ""];
	const htmlParts = [
		`<h1 style="font-size:20px;line-height:1.3;margin:0 0 8px">${escapeHtml(o.heading)}</h1>`,
		`<p style="margin:0 0 20px;color:#4b5563">${escapeHtml(o.intro)}</p>`,
	];
	for (const section of o.sections) {
		const link = section.page ? adminPageUrl(o.siteUrl, section.page) : null;
		textParts.push(section.title.toUpperCase(), ...section.lines.map((l) => `- ${l}`));
		if (link) textParts.push(`${section.pageLabel ?? "Open"}: ${link}`);
		textParts.push("");
		htmlParts.push(
			`<h2 style="font-size:16px;margin:20px 0 6px">${escapeHtml(section.title)}</h2>`,
			`<ul style="margin:0;padding-left:20px">${section.lines.map((l) => `<li style="margin:2px 0">${escapeHtml(l)}</li>`).join("")}</ul>`,
			link ? `<p style="margin:6px 0 0"><a href="${escapeHtml(link)}" style="color:#2563eb">${escapeHtml(section.pageLabel ?? "Open")}</a></p>` : "",
		);
	}
	textParts.push("--", o.footer);
	htmlParts.push(`<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px"><p style="margin:0;font-size:12px;color:#6b7280">${escapeHtml(o.footer)}</p>`);
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111827;background:#ffffff"><div style="max-width:600px;margin:0 auto">${htmlParts.join("")}</div></body></html>`;
	return { subject, text: textParts.join("\n"), html };
}

// ── Recipients ───────────────────────────────────────────────────

/** Most recipients an alert goes to (one message each, so nobody sees the others' addresses). */
export const MAX_RECIPIENTS = 10;

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isEmail(value: string): boolean {
	return value.length <= 254 && EMAIL.test(value);
}

/** Addresses from a list someone typed (commas, semicolons, spaces or lines), lowercased, without duplicates. */
export function parseRecipients(input: string | string[]): { valid: string[]; invalid: string[] } {
	const parts = (Array.isArray(input) ? input : input.split(/[\s,;]+/)).map((p) => p.trim()).filter(Boolean);
	const valid: string[] = [];
	const invalid: string[] = [];
	for (const part of parts) {
		const address = part.toLowerCase();
		if (!isEmail(address)) invalid.push(part);
		else if (!valid.includes(address)) valid.push(address);
	}
	return { valid, invalid };
}

/** The day an issue was last sent, keyed by issue: one email per issue per day at most. UTC date. */
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

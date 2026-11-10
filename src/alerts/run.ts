/**
 * Alerts and the weekly digest, sent with EmDash's ctx.email (the email
 * provider selected under Settings → Email).
 *
 * The hourly check reads what other modules already stored (no network
 * calls, except a once-a-day refresh of the Cloudflare usage reading when
 * the bill alert is on and nobody opened the Performance page that day):
 * - a failed backup (the backups task's recorded outcome, src/core/task-health.ts);
 * - newly broken links (Link Manager's broken links not seen at the last check);
 * - the Cloudflare bill estimate over the threshold (the usage card's reading);
 * - a Coywolf Pack update (the update check's answer);
 * - a content audit that found more problems than the run before.
 * Everything new goes out in one email. Each issue is sent at most once a
 * day, and a lasting condition (the bill, an update) once until it clears.
 */
import type { PluginContext } from "emdash";

import { type DigestSection, DIGEST_SOURCE_MS, cleanSection, digestSources } from "../core/digest.js";
import { type FeatureMap, ctxFeatures, isOn } from "../core/features.js";
import { siteName as readSiteName } from "../core/site.js";
import { DeadlineError, withDeadline } from "../core/single-flight.js";
import { readTaskOutcome } from "../core/task-health.js";
import { BACKUPS_TASK } from "../backups/module.js";
import { CHECK_INFO } from "../audit/checks.js";
import { getReport, worsened } from "../audit/run.js";
import { type UrlRow, getCounts, urls } from "../links/store.js";
import { USAGE_CACHE_KEY, type UsageReport, usageReport } from "../pageCache/usage.js";
import { UPDATE_STATE_SETTING, type UpdateState, showsUpdate } from "../updates/check.js";
import { UPDATE_COMMAND } from "../updates/core.js";
import { type EmailSection, MAX_RECIPIENTS, buildEmail, parseRecipients, today } from "./email.js";

export const SETTINGS_KEY = "alertsSettings";
export const STATE_KEY = "alerts:state";

export const ALERT_TYPES = ["backupFailed", "brokenLinks", "bill", "update", "auditWorsened"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_INFO: Record<AlertType, { label: string; description: string; feature: string }> = {
	backupFailed: { label: "Backup failed", description: "The daily backup job failed, or no scheduled backup has succeeded for longer than Backups allows.", feature: "backups" },
	brokenLinks: { label: "New broken links", description: "Link Manager's scheduled checks found links that weren't broken at the last check.", feature: "links.check" },
	bill: { label: "Cloudflare bill estimate", description: "The 30-day bill estimate from the Cloudflare usage card is over your threshold.", feature: "" },
	update: { label: "Coywolf Pack update", description: "A newer Coywolf Pack is on npm (from the daily update check).", feature: "updates" },
	auditWorsened: { label: "Content audit worsened", description: "The latest content audit found more of a problem than the run before.", feature: "audit" },
};

export interface AlertsSettings {
	recipients: "admins" | "list";
	emails: string[];
	alerts: Record<AlertType, boolean>;
	/** US dollars; 0 turns the bill alert off. */
	billThreshold: number;
}

export const ALERTS_DEFAULTS: AlertsSettings = {
	recipients: "admins",
	emails: [],
	alerts: { backupFailed: true, brokenLinks: true, bill: true, update: true, auditWorsened: true },
	billThreshold: 0,
};

export function normalizeAlertsSettings(raw: unknown): AlertsSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof AlertsSettings, unknown>>;
	const alerts = { ...ALERTS_DEFAULTS.alerts };
	if (r.alerts && typeof r.alerts === "object") for (const t of ALERT_TYPES) if (typeof (r.alerts as Record<string, unknown>)[t] === "boolean") alerts[t] = (r.alerts as Record<string, boolean>)[t];
	const threshold = typeof r.billThreshold === "number" && Number.isFinite(r.billThreshold) && r.billThreshold >= 0 ? Math.min(r.billThreshold, 1_000_000) : 0;
	return {
		recipients: r.recipients === "list" ? "list" : "admins",
		emails: Array.isArray(r.emails) ? parseRecipients(r.emails.filter((e): e is string => typeof e === "string")).valid.slice(0, MAX_RECIPIENTS) : [],
		alerts,
		billThreshold: Math.round(threshold * 100) / 100,
	};
}

export async function readAlertsSettings(ctx: PluginContext): Promise<AlertsSettings> {
	return normalizeAlertsSettings(await ctx.settings.get(SETTINGS_KEY).catch(() => null));
}

export interface SendRecord {
	at: string;
	kind: "alert" | "digest" | "test";
	subject: string;
	sent: number;
	failed: number;
	/** Sends the provider didn't confirm in time (they may still arrive; not sent again). */
	unconfirmed?: number;
	error?: string;
}

export interface AlertsState {
	/** "<issue key>|<recipient>" → the UTC day it was last sent to that recipient. */
	sent: Record<string, string>;
	/** Lasting conditions alerted already, as "<issue key>|<recipient>" (cleared when they end). */
	active: string[];
	/** Broken links (ids) seen at the last check; null until the first check, which only records them. */
	brokenKnown: string[] | null;
	/** The audit report last looked at (its finish time). */
	auditSeen: string | null;
	/** Broken links at the last digest, for "new this week". */
	digestBroken: number | null;
	lastCheckAt: string | null;
	lastDigestAt: string | null;
	log: SendRecord[];
}

/** A fresh empty state (its objects are mutated by a check, so never shared). */
const emptyState = (): AlertsState => ({ sent: {}, active: [], brokenKnown: null, auditSeen: null, digestBroken: null, lastCheckAt: null, lastDigestAt: null, log: [] });

export async function readState(ctx: PluginContext): Promise<AlertsState> {
	const stored = await ctx.kv.get<AlertsState>(STATE_KEY).catch(() => null);
	return { ...emptyState(), ...(stored ?? {}) };
}

async function writeState(ctx: PluginContext, state: AlertsState): Promise<void> {
	// Keep the record small: sent keys from the last 30 days, the last 20 sends.
	const cutoff = today(Date.now() - 30 * 86_400_000);
	state.sent = Object.fromEntries(Object.entries(state.sent).filter(([, day]) => day >= cutoff));
	state.log = state.log.slice(-20);
	await ctx.kv.set(STATE_KEY, state);
}

// ── Email ────────────────────────────────────────────────────────

/** Whether an email provider is set up (EmDash gives plugins ctx.email only then). */
export const emailConfigured = (ctx: PluginContext) => typeof ctx.email?.send === "function";

/** The addresses alerts go to: the site's admins, or the list in settings. */
export async function recipients(ctx: PluginContext, settings: AlertsSettings): Promise<string[]> {
	if (settings.recipients === "list") return settings.emails.slice(0, MAX_RECIPIENTS);
	const users = ctx.users;
	if (!users) return [];
	// EmDash's Admin role is 50.
	const { items } = await users.list({ role: 50, limit: 50 });
	return parseRecipients(items.map((u) => u.email)).valid.slice(0, MAX_RECIPIENTS);
}

/** How long a send may take before it's counted as "unconfirmed" (the provider may still deliver it). */
export const SEND_MS = 20_000;

export type SendOutcome = { outcome: "sent" } | { outcome: "unconfirmed"; error: string } | { outcome: "failed"; error: string };

/**
 * Send one email. Never throws. A send that runs past SEND_MS isn't cancelled
 * (it can't be), so it's "unconfirmed": treated as sent, never repeated at once.
 */
export async function sendOne(ctx: PluginContext, to: string, email: { subject: string; text: string; html: string }): Promise<SendOutcome> {
	if (!emailConfigured(ctx)) return { outcome: "failed", error: "No email provider is set up (Settings → Email)." };
	try {
		await withDeadline(ctx.email!.send({ to, subject: email.subject, text: email.text, html: email.html }), SEND_MS, "Sending an email");
		return { outcome: "sent" };
	} catch (cause) {
		const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
		if (cause instanceof DeadlineError) {
			ctx.log.warn("alerts: the email provider didn't answer in time; the email may still arrive", { error });
			return { outcome: "unconfirmed", error: "The email provider didn't answer in time; the email may still arrive." };
		}
		ctx.log.warn("alerts: an email couldn't be sent", { error });
		return { outcome: "failed", error };
	}
}

/** Send the same email to each recipient (one message each). */
export async function sendToAll(ctx: PluginContext, to: string[], email: { subject: string; text: string; html: string }): Promise<{ sent: number; failed: number; unconfirmed: number; error?: string }> {
	const out = { sent: 0, failed: 0, unconfirmed: 0 } as { sent: number; failed: number; unconfirmed: number; error?: string };
	for (const address of to) {
		const r = await sendOne(ctx, address, email);
		out[r.outcome]++;
		if (r.outcome !== "sent") out.error = r.error;
	}
	return out;
}

/** The key a send is recorded under: the issue, for one recipient. */
export const sentKey = (issueKey: string, recipient: string) => `${issueKey}|${recipient}`;

async function siteFacts(ctx: PluginContext): Promise<{ name: string; url: string }> {
	return { name: (await readSiteName(ctx).catch(() => "")) || ctx.site?.name || "", url: ctx.site?.url ?? "" };
}

// ── Alerts ───────────────────────────────────────────────────────

export interface Issue {
	type: AlertType;
	/** Identifies the issue: sent at most once a day, and once while it lasts when `lasting`. */
	key: string;
	lasting?: boolean;
	section: EmailSection;
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const when = (iso: string) => new Date(iso).toUTCString().replace(" GMT", " UTC");

/** The cached usage reading (no Cloudflare call), refreshed when it's a day old. */
async function usageForAlerts(ctx: PluginContext, now: number): Promise<UsageReport | null> {
	const cached = await ctx.kv.get<UsageReport>(USAGE_CACHE_KEY).catch(() => null);
	if (cached && now - Date.parse(cached.at) < 24 * 3_600_000) return cached;
	const fresh = await usageReport(ctx).catch(() => null);
	return fresh && fresh.configured ? fresh : (cached ?? null);
}

/** What a check saw, recorded once its alerts are sent (or when there were none to send). */
export interface Seen {
	brokenKnown?: string[];
	auditSeen?: string;
}

/** Most broken links compared between checks. */
const BROKEN_MAX = 2_000;

/**
 * Link Manager's broken links (not ignored), most recently checked first, up
 * to BROKEN_MAX: the same order every check, and a link that just broke (just
 * checked) is always among them, so a long list can't make an old one look new.
 */
async function brokenLinks(ctx: PluginContext): Promise<Array<{ id: string; data: UrlRow }>> {
	const out: Array<{ id: string; data: UrlRow }> = [];
	let cursor: string | undefined;
	do {
		const page = await urls(ctx).query({ where: { status: "broken", ignored: false }, orderBy: { checkedAt: "desc" }, limit: 100, cursor });
		out.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && out.length < BROKEN_MAX);
	return out.slice(0, BROKEN_MAX);
}

/** Everything that's wrong right now, as alert issues; `seen` collects what to remember once they're sent. */
export async function gatherIssues(ctx: PluginContext, settings: AlertsSettings, state: AlertsState, features: FeatureMap, now = Date.now(), seen: Seen = {}): Promise<Issue[]> {
	const issues: Issue[] = [];
	const wants = (t: AlertType) => settings.alerts[t] && (!ALERT_INFO[t].feature || isOn(features, ALERT_INFO[t].feature));

	if (wants("backupFailed")) {
		const outcome = await readTaskOutcome(ctx.kv, BACKUPS_TASK);
		if (outcome?.lastFailedAt && (!outcome.lastOkAt || outcome.lastFailedAt > outcome.lastOkAt)) {
			issues.push({ type: "backupFailed", key: `backup-failed:${outcome.lastFailedAt}`, section: { title: "Backup failed", lines: [`The backup job failed at ${when(outcome.lastFailedAt)}.`, ...(outcome.error ? [`Error: ${outcome.error}`] : []), outcome.lastOkAt ? `The last successful run was ${when(outcome.lastOkAt)}.` : "No successful run is recorded yet."], page: "/backups", pageLabel: "Open Backups" } });
		} else if (outcome?.lastOkAt && (await ctx.settings.get<boolean>("backupsScheduled").catch(() => false))) {
			const hours = (await ctx.settings.get<number>("backupsStaleAfterHours").catch(() => null)) ?? 36;
			if (now - Date.parse(outcome.lastOkAt) > hours * 3_600_000) {
				issues.push({ type: "backupFailed", key: `backup-overdue:${outcome.lastOkAt}`, lasting: true, section: { title: "Backups are overdue", lines: [`No scheduled backup has succeeded since ${when(outcome.lastOkAt)} (Backups warns after ${hours} hours).`], page: "/backups", pageLabel: "Open Backups" } });
			}
		}
	}

	if (wants("brokenLinks")) {
		const broken = await brokenLinks(ctx);
		const ids = broken.map((b) => b.id);
		if (state.brokenKnown) {
			const known = new Set(state.brokenKnown);
			const fresh = broken.filter((b) => !known.has(b.id));
			if (fresh.length) {
				issues.push({
					type: "brokenLinks",
					key: `broken-links:${fresh.map((b) => b.id).sort().join(",").slice(0, 200)}`,
					section: {
						title: fresh.length === 1 ? "1 new broken link" : `${fresh.length} new broken links`,
						lines: [...fresh.slice(0, 10).map((b) => `${b.data.url}${b.data.code ? ` (${b.data.code})` : ""}`), ...(fresh.length > 10 ? [`and ${fresh.length - 10} more`] : [])],
						page: "/links",
						pageLabel: "Open Link Manager",
					},
				});
			}
		}
		seen.brokenKnown = ids;
	}

	if (wants("bill") && settings.billThreshold > 0) {
		const usage = await usageForAlerts(ctx, now);
		if (usage && usage.bill.total > settings.billThreshold) {
			issues.push({
				type: "bill",
				key: `bill-over:${settings.billThreshold}`,
				lasting: true,
				section: { title: "Cloudflare bill estimate", lines: [`At the last 30 days' rate the account's bill would be about ${money(usage.bill.total)}, over your threshold of ${money(settings.billThreshold)}.`, `Reading from ${when(usage.at)}. It's an estimate: see the Performance page for what's driving it.`], page: "/performance", pageLabel: "Open Performance" },
			});
		}
	}

	if (wants("update")) {
		const update = await ctx.settings.get<UpdateState>(UPDATE_STATE_SETTING).catch(() => null);
		if (update && showsUpdate(update)) {
			issues.push({ type: "update", key: `update:${update.latest}`, lasting: true, section: { title: "Coywolf Pack update", lines: [`Version ${update.latest} is available.`, `Update the site with ${UPDATE_COMMAND}, then deploy.`] } });
		}
	}

	if (wants("auditWorsened")) {
		const report = await getReport(ctx);
		if (report && report.finishedAt !== state.auditSeen) {
			const worse = worsened(report);
			if (state.auditSeen !== null && worse.length) {
				issues.push({
					type: "auditWorsened",
					key: `audit:${report.runId}`,
					section: { title: "Content audit worsened", lines: worse.map((w) => `${CHECK_INFO[w.check].label}: ${w.before} → ${w.now} entries`), page: "/content-audit", pageLabel: "Open Content Audit" },
				});
			}
			seen.auditSeen = report.finishedAt;
		}
	}
	return issues;
}

/** Issues to send a recipient now: not sent to them today, and lasting ones not already alerted to them while they last. */
export function dueIssues(issues: Issue[], state: AlertsState, now = Date.now(), recipient = ""): Issue[] {
	const day = today(now);
	const active = new Set(state.active);
	return issues.filter((i) => state.sent[sentKey(i.key, recipient)] !== day && !(i.lasting && active.has(sentKey(i.key, recipient))));
}

export interface CheckResult {
	sent: number;
	failed: number;
	unconfirmed: number;
	error?: string;
}

/**
 * The hourly check: gather issues, email each recipient what's new for them,
 * record what was sent. Sends are recorded before they go out (a check cut
 * off mid-send doesn't send again within the day), and a definite failure
 * clears its record, so the next check tries again.
 */
export async function checkAlerts(ctx: PluginContext, now = Date.now()): Promise<{ issues: number; sent: Issue[]; result?: CheckResult }> {
	const [settings, state, features] = await Promise.all([readAlertsSettings(ctx), readState(ctx), ctxFeatures(ctx)]);
	const seen: Seen = {};
	const issues = await gatherIssues(ctx, settings, state, features, now, seen);
	const day = today(now);
	state.lastCheckAt = new Date(now).toISOString();
	let result: CheckResult | undefined;
	const dueTypes = new Set<AlertType>();
	const deliveredTypes = new Set<AlertType>();
	const delivered = new Map<string, Issue>();
	if (issues.length && !emailConfigured(ctx)) {
		// Nothing can go out: the Alerts page says how to set up email. Kept as due, so it's sent once email works.
		for (const i of dueIssues(issues, state, now)) dueTypes.add(i.type);
		if (dueTypes.size) result = { sent: 0, failed: 0, unconfirmed: 0, error: "No email provider is set up (Settings → Email)." };
	} else if (issues.length) {
		const to = await recipients(ctx, settings).catch(() => [] as string[]);
		const plan = to.map((address) => ({ address, due: dueIssues(issues, state, now, address) })).filter((p) => p.due.length);
		for (const p of plan) for (const i of p.due) dueTypes.add(i.type);
		if (!to.length && dueIssues(issues, state, now).length) result = { sent: 0, failed: 0, unconfirmed: 0, error: "No recipients: the site has no admins with an email address, or the list is empty." };
		if (plan.length) {
			for (const p of plan) for (const i of p.due) state.sent[sentKey(i.key, p.address)] = day;
			await writeState(ctx, state);
			const site = await siteFacts(ctx);
			result = { sent: 0, failed: 0, unconfirmed: 0 };
			let subject = "";
			for (const p of plan) {
				const email = buildEmail({
					siteName: site.name,
					siteUrl: site.url,
					subject: p.due.length === 1 ? p.due[0].section.title : `${p.due.length} alerts: ${p.due.map((i) => i.section.title).join(", ")}`,
					heading: p.due.length === 1 ? p.due[0].section.title : `${p.due.length} things need a look`,
					intro: `Coywolf Pack noticed ${p.due.length === 1 ? "something" : "these"} on ${site.name || site.url || "your site"}.`,
					sections: p.due.map((i) => i.section),
					footer: "Sent by Coywolf Pack's Alerts. Choose which alerts you get, and who gets them, on the Alerts page in the site's admin.",
				});
				subject ||= email.subject;
				const r = await sendOne(ctx, p.address, email);
				result[r.outcome]++;
				if (r.outcome === "failed") {
					result.error = r.error;
					for (const i of p.due) delete state.sent[sentKey(i.key, p.address)];
				} else {
					if (r.outcome === "unconfirmed") result.error = r.error;
					for (const i of p.due) {
						deliveredTypes.add(i.type);
						delivered.set(i.key, i);
					}
				}
			}
			state.log.push({ at: state.lastCheckAt, kind: "alert", subject, sent: result.sent, failed: result.failed, ...(result.unconfirmed ? { unconfirmed: result.unconfirmed } : {}), ...(result.error ? { error: result.error } : {}) });
		}
	}
	// What was seen is remembered unless an alert about it was due and reached nobody (then the next check tries again).
	const unsent = (type: AlertType) => dueTypes.has(type) && !deliveredTypes.has(type);
	if (seen.brokenKnown && !unsent("brokenLinks")) state.brokenKnown = seen.brokenKnown;
	if (seen.auditSeen && !unsent("auditWorsened")) state.auditSeen = seen.auditSeen;
	// Lasting conditions alerted to a recipient (or already active for them) stay active while they last.
	const sentToday = new Set(Object.entries(state.sent).filter(([, d]) => d === day).map(([k]) => k));
	const active = new Set(state.active);
	state.active = [...new Set([...active, ...sentToday])].filter((k) => issues.some((i) => i.lasting && k.startsWith(`${i.key}|`)));
	await writeState(ctx, state);
	return { issues: issues.length, sent: [...delivered.values()], ...(result ? { result } : {}) };
}

// ── Weekly digest ────────────────────────────────────────────────

/** The digest's sections: what the pack's modules know, plus any registered sources (Insights). */
export async function digestSections(ctx: PluginContext, state: AlertsState, features: FeatureMap, now = Date.now()): Promise<EmailSection[]> {
	const sections: EmailSection[] = [];

	if (isOn(features, "backups")) {
		const outcome = await readTaskOutcome(ctx.kv, BACKUPS_TASK);
		if (outcome) {
			const failedThisWeek = outcome.lastFailedAt && now - Date.parse(outcome.lastFailedAt) < 7 * 86_400_000;
			sections.push({
				title: "Backups",
				lines: [outcome.lastOkAt ? `Last successful run: ${when(outcome.lastOkAt)}.` : "No successful run recorded yet.", ...(failedThisWeek ? [`A run failed at ${when(outcome.lastFailedAt as string)}${outcome.error ? `: ${outcome.error}` : "."}`] : [])],
				page: "/backups",
				pageLabel: "Open Backups",
			});
		}
	}

	if (isOn(features, "links")) {
		const counts = await getCounts(ctx).catch(() => null);
		if (counts && counts.all) {
			const change = state.digestBroken === null ? null : counts.broken - state.digestBroken;
			sections.push({
				title: "Links",
				lines: [
					`${counts.broken.toLocaleString("en-US")} broken${change ? ` (${change > 0 ? `${change} more` : `${-change} fewer`} than last week)` : ""}, ${counts.redirect.toLocaleString("en-US")} redirecting, ${counts.all.toLocaleString("en-US")} links in all.`,
				],
				page: "/links",
				pageLabel: "Open Link Manager",
			});
			state.digestBroken = counts.broken;
		}
	}

	if (isOn(features, "audit")) {
		const report = await getReport(ctx);
		if (report) {
			const top = Object.entries(report.counts)
				.filter(([check, n]) => n > 0 && !report.off.includes(check as never))
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([check, n]) => {
					const before = report.previous?.counts?.[check as keyof typeof report.counts];
					const delta = before === undefined ? "" : n > before ? ` (up ${n - before})` : n < before ? ` (down ${before - n})` : "";
					return `${CHECK_INFO[check as keyof typeof CHECK_INFO].label}: ${n.toLocaleString("en-US")}${delta}`;
				});
			sections.push({ title: "Content audit", lines: [`${report.entriesWithIssues.toLocaleString("en-US")} of ${report.entries.toLocaleString("en-US")} entries have something to fix (run finished ${when(report.finishedAt)}).`, ...top], page: "/content-audit", pageLabel: "Open Content Audit" });
		}
	}

	const usage = await ctx.kv.get<UsageReport>(USAGE_CACHE_KEY).catch(() => null);
	if (usage?.bill) sections.push({ title: "Cloudflare", lines: [`Estimated bill at the last 30 days' rate: ${money(usage.bill.total)} (reading from ${when(usage.at)}).`], page: "/performance", pageLabel: "Open Performance" });

	if (isOn(features, "updates")) {
		const update = await ctx.settings.get<UpdateState>(UPDATE_STATE_SETTING).catch(() => null);
		if (update && showsUpdate(update)) sections.push({ title: "Coywolf Pack update", lines: [`Version ${update.latest} is available: ${UPDATE_COMMAND}, then deploy.`] });
	}

	// Insights and anything else that registered (src/core/digest.ts): each on its own deadline; a failure leaves it out.
	for (const source of digestSources()) {
		if (!isOn(features, source.feature)) continue;
		try {
			const section: DigestSection | null = cleanSection(await withDeadline(source.read(ctx), DIGEST_SOURCE_MS, `Digest source ${source.id}`));
			if (section) sections.push({ ...section, pageLabel: "Open" });
		} catch (error) {
			ctx.log.warn("alerts: a digest source failed; it's left out", { source: source.id, error: String(error) });
		}
	}
	return sections;
}

/** Build and send the weekly digest (nothing is sent when there's nothing to report). */
/** A digest isn't sent again within this long (a task that fires twice, or one that's retried). */
export const DIGEST_MIN_GAP_MS = 6 * 86_400_000;

export async function sendDigest(
	ctx: PluginContext,
	now = Date.now(),
	options: { preview?: boolean } = {},
): Promise<{ sections: number; skipped?: string; email?: { subject: string; text: string; html: string }; result?: { sent: number; failed: number; unconfirmed: number; error?: string } }> {
	const [settings, state, features] = await Promise.all([readAlertsSettings(ctx), readState(ctx), ctxFeatures(ctx)]);
	if (!options.preview && state.lastDigestAt && now - Date.parse(state.lastDigestAt) < DIGEST_MIN_GAP_MS) return { sections: 0, skipped: `A digest went out ${state.lastDigestAt}.` };
	const sections = await digestSections(ctx, state, features, now);
	if (!sections.length) return { sections: 0 };
	const site = await siteFacts(ctx);
	const email = buildEmail({
		siteName: site.name,
		siteUrl: site.url,
		subject: "Your weekly site digest",
		heading: `This week on ${site.name || site.url || "your site"}`,
		intro: "A summary from Coywolf Pack: backups, links, content and costs.",
		sections,
		footer: "Sent weekly by Coywolf Pack's Alerts. Turn the digest off, or change who gets it, on the Alerts page in the site's admin.",
	});
	if (options.preview) return { sections: sections.length, email };
	const to = await recipients(ctx, settings).catch(() => [] as string[]);
	if (!to.length) return { sections: sections.length, result: { sent: 0, failed: 0, unconfirmed: 0, error: "No recipients." } };
	// Recorded before sending: a run cut off mid-send, or fired twice, doesn't send the digest again this week.
	const previous = state.lastDigestAt;
	state.lastDigestAt = new Date(now).toISOString();
	await writeState(ctx, state);
	const result = await sendToAll(ctx, to, email);
	// Nobody got it (every send failed outright): the next run may try again.
	if (!result.sent && !result.unconfirmed) state.lastDigestAt = previous;
	state.log.push({ at: new Date(now).toISOString(), kind: "digest", subject: email.subject, sent: result.sent, failed: result.failed, ...(result.unconfirmed ? { unconfirmed: result.unconfirmed } : {}), ...(result.error ? { error: result.error } : {}) });
	await writeState(ctx, state);
	return { sections: sections.length, result };
}

/** A test email to the recipients, so a site can see the provider works. */
export async function sendTest(ctx: PluginContext): Promise<{ to: number; sent: number; failed: number; unconfirmed?: number; error?: string }> {
	const [settings, state] = await Promise.all([readAlertsSettings(ctx), readState(ctx)]);
	const to = await recipients(ctx, settings);
	const site = await siteFacts(ctx);
	const email = buildEmail({
		siteName: site.name,
		siteUrl: site.url,
		subject: "Test alert",
		heading: "Alerts can reach you",
		intro: "This is a test from Coywolf Pack's Alerts. If you're reading it, alert emails from this site will reach you too.",
		sections: [],
		footer: "Sent because someone selected Send test email on the Alerts page.",
	});
	const result = to.length ? await sendToAll(ctx, to, email) : { sent: 0, failed: 0, error: "No recipients." };
	state.log.push({ at: new Date().toISOString(), kind: "test", subject: email.subject, sent: result.sent, failed: result.failed, ...(result.error ? { error: result.error } : {}) });
	await writeState(ctx, state);
	return { to: to.length, ...result };
}

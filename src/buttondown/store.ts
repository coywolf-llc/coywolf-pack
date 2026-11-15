/**
 * Buttondown Drafts' records (plugin storage `buttondownEmails`, one per entry,
 * id "<collection>:<entry id>"), and what the admin may see of one: the state
 * in plain words, the email id and its link in Buttondown, the post, times,
 * warnings and the last error (Buttondown's code and its scrubbed detail).
 * Never the key, the email's body or a Buttondown answer.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { BUTTONDOWN_APP, BUTTONDOWN_LIMITS, BUTTONDOWN_STORAGE } from "./keys.js";
import { type ButtondownRecord, readRecord, stateText } from "./sync-core.js";

/** Indexed: the hourly task's queries (state, nextRetryAt) and the page's recent list (updatedAt). */
export const BUTTONDOWN_STORAGE_CONFIG = { [BUTTONDOWN_STORAGE]: { indexes: ["state", "nextRetryAt", "updatedAt"] } };

export const records = (ctx: Pick<PluginContext, "storage">) => (ctx.storage as Record<string, StorageCollection<ButtondownRecord>>)[BUTTONDOWN_STORAGE];

/** Where a draft opens in Buttondown's app. */
export const appUrl = (emailId: string | null) => (emailId ? `${BUTTONDOWN_APP}/emails/${encodeURIComponent(emailId)}` : null);

export interface RecordView {
	collection: string;
	entryId: string;
	state: ButtondownRecord["state"];
	text: string;
	job: ButtondownRecord["job"];
	emailId: string | null;
	appUrl: string | null;
	remoteStatus: string | null;
	title: string;
	postUrl: string | null;
	createdAt: string;
	updatedAt: string;
	nextRetryAt: string | null;
	warnings: string[];
	lastError: ButtondownRecord["lastError"];
	unpublished: boolean;
	trashed: boolean;
	deleted: boolean;
	manual: boolean;
}

export function recordView(r: ButtondownRecord): RecordView {
	return {
		collection: r.collection,
		entryId: r.entryId,
		state: r.state,
		text: stateText(r),
		job: r.job,
		emailId: r.emailId,
		appUrl: r.state === "removed" || r.state === "gone" ? null : appUrl(r.emailId),
		remoteStatus: r.remoteStatus,
		title: r.title,
		postUrl: r.postUrl,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		nextRetryAt: r.nextRetryAt,
		warnings: [...r.warnings, ...(r.extraEmails.length ? [`Buttondown may have ${r.extraEmails.length === 1 ? "another draft" : `${r.extraEmails.length} more drafts`} for this post (${r.extraEmails.join(", ")}), made while two jobs ran at once. Delete ${r.extraEmails.length === 1 ? "it" : "them"} there.`] : [])].slice(0, 10),
		lastError: r.lastError ? { at: r.lastError.at, status: r.lastError.status, code: r.lastError.code, message: r.lastError.message } : null,
		unpublished: r.unpublished,
		trashed: r.trashed,
		deleted: r.deleted,
		manual: r.manual,
	};
}

/** The most recently changed records. */
export async function recentRecords(ctx: Pick<PluginContext, "storage">, limit = 20): Promise<ButtondownRecord[]> {
	const page = await records(ctx).query({ orderBy: { updatedAt: "desc" }, limit });
	return page.items.map((i) => readRecord(i.data)).filter((r): r is ButtondownRecord => r !== null);
}

/**
 * Records in error for over an hour (Alerts' buttondownFailed). A failed create or update of a post that has since
 * been unpublished, trashed or deleted isn't one: there's nothing left to make. A failing delete is.
 */
export async function failingRecords(ctx: Pick<PluginContext, "storage">, now = Date.now()): Promise<ButtondownRecord[]> {
	const store = records(ctx);
	if (!store) return [];
	const page = await store.query({ where: { state: "error" }, orderBy: { updatedAt: "desc" }, limit: 50 });
	return page.items
		.map((i) => readRecord(i.data))
		.filter((r): r is ButtondownRecord => Boolean(r && now - (Date.parse(r.errorSince ?? "") || now) >= BUTTONDOWN_LIMITS.alertAfterMs))
		.filter((r) => r.job === "remove" || !(r.unpublished || r.trashed || r.deleted));
}

/** What a failing record couldn't do, for the alert's title. */
export function failedJob(r: Pick<ButtondownRecord, "job" | "emailId">): "created" | "updated" | "deleted" {
	return r.job === "remove" ? "deleted" : r.emailId ? "updated" : "created";
}

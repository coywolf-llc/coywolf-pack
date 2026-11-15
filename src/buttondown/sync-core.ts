/**
 * Buttondown Drafts: the record kept per entry and the pure decisions made on
 * it. What an EmDash event means for the entry's draft (decideEvent), what
 * Buttondown's answer means for an update (classifyRemote), and what a failure
 * means for the next try (failure). No I/O: src/buttondown/sync.ts does the
 * reads, writes and calls. The lifecycle table in docs/buttondown.md is this
 * file in words.
 *
 * Kept free of imports beyond its siblings' constants so tests can load it directly.
 */
import { BUTTONDOWN_BACKOFF_MS, BUTTONDOWN_LIMITS, BUTTONDOWN_RETRY_FOR_MS } from "./keys.js";

export type RecordState =
	/** Queued: a job was handed over (or will be, by the hourly task). */
	| "pending"
	/** A create is under way (claimed). */
	| "creating"
	/** The draft exists and the Pack last wrote it. */
	| "draft"
	/** Buttondown says it isn't a draft any more (scheduled, sent…): the Pack leaves it alone. */
	| "left"
	/** Changed in Buttondown since the Pack's last write: not updated (Refresh draft from post overwrites). */
	| "edited"
	/** Deleted in Buttondown: never made again on its own (Create draft now does). */
	| "gone"
	/** The post was unpublished or trashed: the draft is being deleted (or a delete is waiting to be retried). */
	| "removing"
	/** The Pack deleted the untouched draft after the post was unpublished or trashed. The next publish makes a new one. */
	| "removed"
	/** The last try failed (lastError). */
	| "error"
	/** The post no longer matches a rule, or was deleted: the Pack stopped watching. The draft is left as it is. */
	| "stopped";

export type JobKind = "sync" | "remove";

export interface RecordError {
	at: string;
	/** HTTP status (0: no answer). */
	status: number;
	code: string | null;
	message: string;
}

export interface ButtondownRecord {
	collection: string;
	entryId: string;
	state: RecordState;
	/** What the pending, error or removing record is waiting to do. Null once settled. */
	job: JobKind | null;
	emailId: string | null;
	/** Hash of the fields last written (src/buttondown/body.ts emailHash). */
	hash: string | null;
	/**
	 * Buttondown's modification_date right after the Pack's own last write (or of a draft it adopted that nobody had
	 * changed since it was made). Null for an email the Pack found already changed, scheduled or sent: with no date
	 * of its own to compare, the Pack never updates or deletes that one.
	 */
	remoteModifiedAt: string | null;
	remoteStatus: string | null;
	claimedAt: string | null;
	claimToken: string | null;
	/** An event arrived while a job held the claim: run once more when it's done. */
	dirty: boolean;
	/** Failures in a row (backoff step). */
	attempts: number;
	/** When the hourly task should try again (indexed). Null: not waiting. */
	nextRetryAt: string | null;
	/** When the failures started (Alerts reports a record in error this long). */
	errorSince: string | null;
	lastError: RecordError | null;
	/** A key refused (401, 403) or missing: the fingerprint of the key it was, "none" without one. Retried once the key changes. */
	authFingerprint: string | null;
	warnings: string[];
	title: string;
	postUrl: string | null;
	createdAt: string;
	updatedAt: string;
	unpublished: boolean;
	trashed: boolean;
	/** The post was deleted for good. */
	deleted: boolean;
	/** Made with Create draft now (the rule's "since" didn't apply). */
	manual: boolean;
	/** Buttondown refused the slug once: it's left out. */
	noSlug: boolean;
	/**
	 * The hook couldn't read the rules when it queued the job, so "first published since the rule was saved" wasn't
	 * checked: the job checks it before it creates anything. Cleared only when a step settles (the check passed and
	 * the draft exists, or there's nothing to make), so a post first published before the rule's `since` never gets a
	 * draft on its own.
	 */
	sinceUnchecked: boolean;
	/**
	 * When a create went out and got no answer (no response, a timeout, a 5xx): Buttondown may have made the draft
	 * although the record names none. If the post leaves the site before a retry finds it, the Pack looks for that
	 * draft by its key and deletes it while it's untouched. Cleared when a step settles.
	 */
	createSentAt: string | null;
	/**
	 * When the Pack's own DELETE went out and got no answer: it may have landed. If the email then turns out to be
	 * gone (404), that was the Pack's delete (`removed`), not one made in Buttondown (`gone`). Cleared when a step settles.
	 */
	deleteSentAt: string | null;
	/**
	 * Other drafts the Pack made for this post: a job that lost its claim (it ran past 2 minutes and another job took
	 * over) after making one. Shown as a warning, so you can delete the extra one in Buttondown.
	 */
	extraEmails: string[];
}

export const recordId = (collection: string, entryId: string) => `${collection}:${entryId}`;

export function newRecord(collection: string, entryId: string, now: number): ButtondownRecord {
	const at = new Date(now).toISOString();
	return {
		collection,
		entryId,
		state: "pending",
		job: "sync",
		emailId: null,
		hash: null,
		remoteModifiedAt: null,
		remoteStatus: null,
		claimedAt: null,
		claimToken: null,
		dirty: false,
		attempts: 0,
		nextRetryAt: null,
		errorSince: null,
		lastError: null,
		authFingerprint: null,
		warnings: [],
		title: "",
		postUrl: null,
		createdAt: at,
		updatedAt: at,
		unpublished: false,
		trashed: false,
		deleted: false,
		manual: false,
		noSlug: false,
		sinceUnchecked: false,
		createSentAt: null,
		deleteSentAt: null,
		extraEmails: [],
	};
}

/** A stored record with every field present (older or partial documents read safely). */
export function readRecord(raw: unknown): ButtondownRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Partial<ButtondownRecord>;
	if (typeof r.collection !== "string" || typeof r.entryId !== "string") return null;
	// `force` was a field once (a standing order to overwrite): never read back.
	const { force: _force, ...stored } = r as Partial<ButtondownRecord> & { force?: unknown };
	return {
		...newRecord(r.collection, r.entryId, Date.parse(r.createdAt ?? "") || 0),
		...stored,
		warnings: Array.isArray(r.warnings) ? r.warnings.filter((w) => typeof w === "string") : [],
		extraEmails: Array.isArray(r.extraEmails) ? r.extraEmails.filter((e) => typeof e === "string") : [],
	};
}

export type EventKind = "publish" | "save" | "unpublish" | "trash" | "delete" | "restore";

export interface EventFacts {
	/** The entry is live: a publish, or a save of a published entry that isn't a draft revision. */
	live: boolean;
	/** The collection has a rule and the entry has one of its terms (or a child term). */
	matches: boolean;
	/** First published at or after the rule was saved. */
	newEnough: boolean;
	/** The Updates part is on. */
	updatesOn: boolean;
	/**
	 * The record's last failure was a refused or missing key, and the saved key is still that one: a publish or save
	 * makes no call with it. The record waits for another key, for Retry, or for the one retry a 403 gets.
	 */
	sameRefusedKey?: boolean;
}

/** What to do for an event: write `patch` over the record (creating it when there's none), and run `run` after the response. */
export interface Decision {
	run: JobKind | null;
	/** Fields to set (null: write nothing). */
	patch: Partial<ButtondownRecord> | null;
	/** Why, for tests and logs. */
	reason: string;
}

const none = (reason: string, patch: Partial<ButtondownRecord> | null = null): Decision => ({ run: null, patch, reason });
const queue = (run: JobKind, patch: Partial<ButtondownRecord>, reason: string): Decision => ({ run, patch, reason });

/** A record with nothing waiting and no failure on it. */
export const CLEARED = { job: null, attempts: 0, nextRetryAt: null, errorSince: null, lastError: null, authFingerprint: null } as const;
/** No write of the Pack's own is waiting for an answer that never came. */
export const UNSENT = { createSentAt: null, deleteSentAt: null } as const;

const hasDraft = (r: ButtondownRecord) => Boolean(r.emailId) && r.state !== "gone" && r.state !== "removed";
/** A job (create, update or delete) holds the record right now. */
export const isBusy = (r: ButtondownRecord) => r.state === "pending" || r.state === "creating";

/**
 * A create that Buttondown answered with a 2xx and no email the Pack could read. It may have made a draft that the
 * Pack's lookup can't see either, so nothing creates again on its own: not a retry, not a republish, not a second
 * pass of the same job. Only Retry (or Create draft now) does, and it looks first.
 */
export const awaitsRetry = (r: Pick<ButtondownRecord, "state" | "emailId" | "lastError">): boolean => r.state === "error" && !r.emailId && r.lastError?.code === "unexpected_answer";

/**
 * What a new attempt that a person started (a republish, an unpublish, Retry, another key) resets on a failed
 * record. The earlier failure is over when nothing is planned for it any more (its kind isn't retried, or its
 * 3 days have passed), or when the step changes (make or update ↔ delete): what fails next is a new failure, with
 * its own retries and its own alert. A failure that's still being retried keeps its start.
 */
export function freshAttempt(record: Pick<ButtondownRecord, "errorSince" | "nextRetryAt" | "job">, job: JobKind, now: number): Partial<ButtondownRecord> {
	if (!record.errorSince) return {};
	const over = !record.nextRetryAt || now - (Date.parse(record.errorSince) || 0) >= BUTTONDOWN_RETRY_FOR_MS;
	return over || record.job !== job ? { errorSince: null, attempts: 0 } : {};
}

/**
 * An EmDash event for an entry whose collection has a rule (or a record). The lifecycle table (docs/buttondown.md,
 * section "What happens when") row by row.
 */
export function decideEvent(kind: EventKind, record: ButtondownRecord | null, facts: EventFacts): Decision {
	if (kind === "restore") {
		// EmDash restores an entry as a draft: nothing to send. Publishing it again makes or updates the draft.
		return record?.trashed ? none("restored", { trashed: false }) : none("restored");
	}

	if (kind === "unpublish" || kind === "trash" || kind === "delete") {
		if (!record) return none("no draft");
		const flag: Partial<ButtondownRecord> = kind === "unpublish" ? { unpublished: true } : kind === "trash" ? { trashed: true } : { deleted: true };
		// A job is under way: it checks the entry again when it's done (dirty) and deletes the draft it made then.
		if (isBusy(record)) return none("job under way", { ...flag, dirty: true });
		if (!hasDraft(record)) {
			// A create that got no answer may have made a draft the record doesn't name: look for it and delete it while
			// it's untouched (removeStep, through deleteDraft's own read).
			if (!record.emailId && record.createSentAt && (record.state === "error" || record.state === "removing")) return queue("remove", { ...flag, ...CLEARED, state: "removing", job: "remove" }, "the create may have landed: look for its draft");
			// A create that failed and whose post is gone from the site: nothing left to make or to report (Alerts).
			if (record.state === "error" || kind === "delete") return none("no draft", { ...flag, ...CLEARED, ...UNSENT, state: "stopped" });
			return none("no draft", flag);
		}
		// Kept: edited in Buttondown, or no longer watched. The panel and list say so.
		if (record.state === "edited") return none("edited in Buttondown: kept", kind === "delete" ? { ...flag, state: "stopped", job: null } : flag);
		if (record.state === "stopped") return none("not watched: kept", flag);
		// draft, left (it may be a draft again), removing, error: deleteDraft's own read decides.
		return queue("remove", { ...flag, state: "removing", job: "remove" }, "delete the untouched draft");
	}

	// publish or save
	if (!facts.live) return none("not live");
	const back: Partial<ButtondownRecord> = record && (record.unpublished || record.trashed) ? { unpublished: false, trashed: false } : {};
	if (!record) return facts.matches && facts.newEnough ? queue("sync", {}, "first publish") : none(facts.matches ? "published before the rule" : "no match");
	const patch = (p: Partial<ButtondownRecord> = {}) => ({ ...back, ...p });

	if (isBusy(record)) return queue("sync", patch({ dirty: true }), "job under way: once more after it");

	if (!facts.matches) {
		// The category was removed: stop watching, leave the draft alone.
		if (hasDraft(record) && record.state !== "stopped") return none("no longer matches", patch({ state: "stopped", job: null, nextRetryAt: null }));
		return none("no match", Object.keys(back).length ? back : null);
	}

	switch (record.state) {
		case "gone":
			return none("deleted in Buttondown: not made again", Object.keys(back).length ? back : null);
		case "removed":
			return facts.newEnough || record.manual ? queue("sync", patch({ state: "pending", job: "sync", emailId: null, hash: null, remoteModifiedAt: null, remoteStatus: null }), "published again after a delete") : none("published before the rule");
		case "stopped":
			if (record.emailId) return queue("sync", patch({ state: "pending", job: "sync" }), "matches again: check the draft");
			return facts.newEnough || record.manual ? queue("sync", patch({ state: "pending", job: "sync" }), "matches again") : none("published before the rule");
		case "edited":
			return none("edited in Buttondown: not updated", Object.keys(back).length ? back : null);
		case "removing":
			// Published again before the Pack looked for a draft its lost create may have made: the create's own lookup finds it.
			if (!record.emailId) return queue("sync", patch({ state: "pending", job: "sync" }), "delete cancelled: create");
			// The Pack's delete got no answer: it may have landed, so the draft is read whether or not updates are on
			// (pending, not draft: an unchanged post must not settle without that read).
			if (record.deleteSentAt) return queue("sync", patch({ state: "pending", job: "sync" }), "delete cancelled: check the draft");
			// Published again before the delete ran: no delete, and the draft is updated as on a republish.
			return facts.updatesOn ? queue("sync", patch({ state: "draft", job: "sync" }), "delete cancelled: update") : none("delete cancelled", patch({ state: "draft", job: null, nextRetryAt: null }));
		case "error":
			// A refused or missing key that's still the saved one: no call with it. What's planned for the record stands
			// (a 403's retry an hour later, the hourly task once the key changes, Retry). A waiting delete stays queued:
			// its step sees the post is live again and updates the draft instead.
			if (facts.sameRefusedKey) return none("the key was refused: waiting for another key or Retry", Object.keys(back).length ? back : null);
			// The create's answer couldn't be read: a draft may exist that the lookup can't see. No second create on a republish.
			if (awaitsRetry(record)) return none("the create's answer couldn't be read: waiting for Retry", Object.keys(back).length ? back : null);
			if (!record.emailId) return queue("sync", patch({ job: "sync" }), "create again");
			// The Pack's delete got no answer: it may have landed, so the draft is checked whether or not updates are on.
			if (record.job === "remove") return facts.updatesOn || record.deleteSentAt ? queue("sync", patch({ job: "sync" }), "delete cancelled: check the draft") : none("delete cancelled", patch({ state: "draft", job: null, nextRetryAt: null }));
			return facts.updatesOn ? queue("sync", patch({ job: "sync" }), "update again") : none("updates off", Object.keys(back).length ? back : null);
		case "draft":
		case "left":
		default:
			return facts.updatesOn ? queue("sync", patch({ job: "sync" }), "republish: update") : none("updates off", Object.keys(back).length ? back : null);
	}
}

export type RemoteVerdict = "update" | "gone" | "left" | "edited";

/**
 * Whether the Pack may write the draft: still a draft in Buttondown, and not changed there since the Pack's last
 * write (Buttondown's modification_date is the one the Pack recorded then), with the Pack's own key in its metadata.
 *
 * `seenModifiedAt` (Refresh draft from post): the modification_date the admin was shown before confirming. The
 * draft may then be overwritten although it was changed in Buttondown, but only while Buttondown still shows that
 * exact date. Anything else is "edited": changed again since the admin looked. Refresh also needs the Pack's key
 * for this post in the email's metadata: an email whose key was removed or changed there is never written.
 */
export function classifyRemote(remote: { status: string; modificationDate: string | null; key: string | null } | null, record: Pick<ButtondownRecord, "remoteModifiedAt">, expectedKey: string, seenModifiedAt: string | null = null): RemoteVerdict {
	if (!remote) return "gone";
	if (remote.status !== "draft") return "left";
	if (seenModifiedAt !== null) return seenModifiedAt !== "" && remote.modificationDate === seenModifiedAt && remote.key === expectedKey ? "update" : "edited";
	if (!record.remoteModifiedAt || remote.modificationDate !== record.remoteModifiedAt || remote.key !== expectedKey) return "edited";
	return "update";
}

/**
 * A draft found in Buttondown by the Pack's key (a create whose answer was lost, or one made before): the Pack's to
 * write and delete only when nobody changed it since it was made, which only Buttondown's own times can say (its
 * modification and creation times within a second of each other). The hash in the Pack's metadata says nothing
 * here: an edit in Buttondown doesn't change it.
 */
export function adoptable(found: { modificationDate: string | null; creationDate: string | null }): boolean {
	const m = Date.parse(found.modificationDate ?? "");
	const c = Date.parse(found.creationDate ?? "");
	return Number.isFinite(m) && Number.isFinite(c) && Math.abs(m - c) < 1000;
}

export interface FailureInput {
	status: number;
	code: string | null;
	/** Seconds, from Retry-After. */
	retryAfter: number | null;
	/** A refusal by the Pack's own guard (a bug), not Buttondown's answer. */
	refused?: boolean;
}

export interface FailurePlan {
	kind: "temporary" | "rate" | "auth" | "refused" | "fatal";
	/** When the hourly task tries again; null: not on its own. */
	nextRetryAt: string | null;
}

/**
 * What a failure means for the next try. Every kind has an end: nothing is tried again on its own once the failures
 * have lasted 3 days. Retry, a republish, an unpublish or another key start a new attempt, and what fails then is a
 * new failure with its own 3 days (freshAttempt).
 * - 429: after Retry-After (at least 5 minutes), for 3 days from the first failure.
 * - no answer, a timeout, 5xx, 409: 5 min, 15 min, 1 h, 3 h, 6 h, then every 6 h, for 3 days from the first failure.
 * - 401, no key: not until the key changes (or Retry).
 * - 403: once more an hour later (Buttondown also answers 403 when it throttles Workers' addresses), then as 401.
 * - 400, 422, other 4xx, a guard refusal: not on its own (Retry).
 * - a 2xx with no email in it (unexpected_answer): not on its own, and not by a republish (Retry).
 */
export function failure(input: FailureInput, record: Pick<ButtondownRecord, "attempts" | "errorSince">, now: number): FailurePlan {
	if (input.refused) return { kind: "refused", nextRetryAt: null };
	// A 2xx the Pack couldn't read: the write may be done, and a retry could do it twice.
	if (input.code === "unexpected_answer") return { kind: "fatal", nextRetryAt: null };
	const lasted = now - (Date.parse(record.errorSince ?? "") || now);
	if (input.status === 429) {
		if (lasted >= BUTTONDOWN_RETRY_FOR_MS) return { kind: "rate", nextRetryAt: null };
		const wait = Math.max((input.retryAfter ?? 0) * 1000, BUTTONDOWN_BACKOFF_MS[0]);
		return { kind: "rate", nextRetryAt: new Date(now + wait).toISOString() };
	}
	if (input.status === 403 && record.attempts === 0) return { kind: "auth", nextRetryAt: new Date(now + BUTTONDOWN_LIMITS.forbiddenRetryMs).toISOString() };
	if (input.status === 401 || input.status === 403 || input.code === "no_key") return { kind: "auth", nextRetryAt: null };
	if (input.status === 0 || input.status >= 500 || input.status === 409) {
		if (lasted >= BUTTONDOWN_RETRY_FOR_MS) return { kind: "temporary", nextRetryAt: null };
		const step = BUTTONDOWN_BACKOFF_MS[Math.min(record.attempts, BUTTONDOWN_BACKOFF_MS.length - 1)];
		return { kind: "temporary", nextRetryAt: new Date(now + step).toISOString() };
	}
	return { kind: "fatal", nextRetryAt: null };
}

/** The hourly task's to finish: queued or claimed but untouched for 5 minutes (its job was dropped or cut off). */
export function isStuck(record: Pick<ButtondownRecord, "state" | "updatedAt" | "claimedAt">, now: number): boolean {
	if (!(record.state === "pending" || record.state === "creating" || record.state === "removing")) return false;
	const at = Math.max(Date.parse(record.updatedAt) || 0, Date.parse(record.claimedAt ?? "") || 0);
	return now - at >= BUTTONDOWN_LIMITS.stuckMs;
}

/** Another job's claim that's still fresh (younger than 2 minutes). */
export function claimHeld(record: Pick<ButtondownRecord, "claimToken" | "claimedAt">, token: string, now: number): boolean {
	if (!record.claimToken || record.claimToken === token) return false;
	return now - (Date.parse(record.claimedAt ?? "") || 0) < BUTTONDOWN_LIMITS.claimStaleMs;
}

/**
 * Records the hourly task prunes once nothing has changed them for 180 days: the done ones, and a failure nobody
 * retried in all that time (its own retries ended after 3 days).
 */
export const PRUNABLE: readonly RecordState[] = ["left", "gone", "stopped", "removed", "error"];

/**
 * A failed record that a hook queued while the rules couldn't be read, and for which nothing was made: the hook
 * never saw a rule for its collection. Once the rules read and there's none, it isn't a failure: there's nothing to make.
 */
export const isUnsure = (record: Pick<ButtondownRecord, "state" | "sinceUnchecked" | "emailId" | "createSentAt">): boolean => record.state === "error" && record.sinceUnchecked && !record.emailId && !record.createSentAt;

/** Whether Alerts still reports a failing record: in error for over an hour, and for less than the 3 days it's retried. */
export function alertDue(record: Pick<ButtondownRecord, "errorSince">, now: number): boolean {
	const lasted = now - (Date.parse(record.errorSince ?? "") || now);
	return lasted >= BUTTONDOWN_LIMITS.alertAfterMs && lasted < BUTTONDOWN_RETRY_FOR_MS;
}

/** The record's state in plain words, for the panel and the list. */
export function stateText(r: Pick<ButtondownRecord, "state" | "remoteStatus" | "lastError" | "unpublished" | "trashed" | "deleted" | "job"> & { emailId?: string | null }): string {
	const kept = r.deleted ? " The post was deleted." : r.trashed ? " The post is in the trash." : r.unpublished ? " The post isn't published." : "";
	switch (r.state) {
		case "pending":
			return "Waiting to be made or updated.";
		case "creating":
			return "Creating the draft…";
		case "draft":
			return "Draft in Buttondown.";
		case "left":
			return `${r.remoteStatus === "sent" ? "Sent" : `${(r.remoteStatus ?? "Not a draft").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}`} in Buttondown. The Pack leaves it alone.${kept}`;
		case "edited":
			return `Edited in Buttondown, so the Pack doesn't change it.${kept ? `${kept} Kept because you edited it in Buttondown.` : ""}`;
		case "gone":
			return "Deleted in Buttondown. The Pack doesn't make it again on its own.";
		case "removing":
			return "Deleting the draft (the post was unpublished or trashed)…";
		case "removed":
			return "Deleted: the post was unpublished or trashed while the draft was untouched. Publishing it again makes a new draft.";
		case "error":
			return `${r.job === "remove" ? "Couldn't delete the draft" : "Couldn't make or update the draft"}: ${r.lastError?.message ?? "unknown error"}`;
		case "stopped":
			if (!r.emailId && !r.deleted && (r.unpublished || r.trashed)) return "No draft was made before the post was unpublished or trashed. Publishing it again makes one.";
			return `Not watched: the post no longer matches a rule${r.deleted ? " or was deleted" : ""}. The draft, if any, is left as it is.`;
	}
}

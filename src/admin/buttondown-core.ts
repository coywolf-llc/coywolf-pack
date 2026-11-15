/**
 * What the Buttondown Drafts page (src/admin/buttondown.tsx) and the entry
 * editor's Buttondown panel (src/admin/editor-panels.tsx) share, kept free of
 * React so Node can test it: the record as the routes return it, its state as
 * a short badge, and the panel's one read per entry, shared between EmDash's
 * isVisible check and the panel's first render.
 */
import { PACK_API, apiPost } from "./api.js";

export type RecordState = "pending" | "creating" | "draft" | "left" | "edited" | "gone" | "removing" | "removed" | "error" | "stopped";

/** A record as the routes return it (src/buttondown/store.ts recordView). */
export interface RecordView {
	collection: string;
	entryId: string;
	state: RecordState;
	text: string;
	job: "sync" | "remove" | null;
	emailId: string | null;
	appUrl: string | null;
	remoteStatus: string | null;
	title: string;
	postUrl: string | null;
	createdAt: string;
	updatedAt: string;
	nextRetryAt: string | null;
	warnings: string[];
	lastError: { at: string; status: number; code: string | null; message: string } | null;
	unpublished: boolean;
	trashed: boolean;
	deleted: boolean;
	manual: boolean;
}

/** buttondown/entry: the panel's data. `covered: false` when no rule covers the collection (the panel doesn't show). */
export interface ButtondownEntry {
	covered: boolean;
	published?: boolean;
	matches?: boolean;
	keySaved?: boolean;
	record?: RecordView | null;
	canCreate?: boolean;
	canRefresh?: boolean;
	canRetry?: boolean;
}

export type BadgeVariant = "primary" | "secondary" | "outline" | "error";

/** A record's state as a short badge (the sentence goes next to it). */
export const STATE_BADGE: Record<RecordState, { label: string; variant: BadgeVariant }> = {
	pending: { label: "Waiting", variant: "secondary" },
	creating: { label: "Creating", variant: "secondary" },
	draft: { label: "Draft", variant: "primary" },
	left: { label: "Not a draft", variant: "outline" },
	edited: { label: "Edited in Buttondown", variant: "outline" },
	gone: { label: "Deleted in Buttondown", variant: "outline" },
	removing: { label: "Deleting", variant: "secondary" },
	removed: { label: "Deleted", variant: "outline" },
	error: { label: "Failed", variant: "error" },
	stopped: { label: "Not watched", variant: "outline" },
};

/** The badge's words: Buttondown's own status ("Sent", "Scheduled") for an email the Pack no longer changes. */
export function badgeLabel(record: Pick<RecordView, "state" | "remoteStatus">): string {
	if (record.state === "left") return record.remoteStatus ? record.remoteStatus.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : STATE_BADGE.left.label;
	return STATE_BADGE[record.state]?.label ?? record.state;
}

const post = apiPost(`${PACK_API}/buttondown`);

/** One read per entry version: EmDash's isVisible check and the panel's first load share it (kept 15 seconds). */
const reads = new Map<string, { at: number; promise: Promise<ButtondownEntry> }>();
const READ_MS = 15_000;

export function buttondownEntry(collection: string, id: string, version = "", options: { fresh?: boolean; now?: number; fetcher?: (body: { collection: string; id: string }) => Promise<ButtondownEntry> } = {}): Promise<ButtondownEntry> {
	const now = options.now ?? Date.now();
	const key = `${collection}\n${id}\n${version}`;
	const hit = reads.get(key);
	if (!options.fresh && hit && now - hit.at < READ_MS) return hit.promise;
	if (reads.size > 50) reads.clear();
	const fetcher = options.fetcher ?? ((body) => post<ButtondownEntry>("entry", body, "Couldn't read the Buttondown draft"));
	const promise = fetcher({ collection, id });
	promise.catch(() => reads.delete(key));
	reads.set(key, { at: now, promise });
	return promise;
}

/** EmDash's isVisible for the panel: only in collections a rule covers. False (hidden) when it can't be read. */
export async function buttondownPanelVisible(context: { collection: string; entry: { id: string; updatedAt?: string } }): Promise<boolean> {
	try {
		return (await buttondownEntry(context.collection, context.entry.id, context.entry.updatedAt ?? "")).covered === true;
	} catch {
		return false;
	}
}

/** "2 minutes ago". */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
	const at = Date.parse(iso ?? "");
	if (!Number.isFinite(at)) return "";
	const seconds = Math.round((at - now) / 1000);
	const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
	const abs = Math.abs(seconds);
	if (abs < 60) return rtf.format(seconds, "second");
	if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
	if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
	return rtf.format(Math.round(seconds / 86_400), "day");
}

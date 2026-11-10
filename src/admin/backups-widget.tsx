/**
 * The Backups dashboard widget, and what the Backups page shares with it.
 * Its own file, so the dashboard doesn't load the Backups page.
 */
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { PACK_API, errorText } from "./api.js";
import { Loading } from "./page.js";

export const BACKUPS_API = `${PACK_API}/backups`;

export interface Backup {
	stamp: string;
	createdAt: string;
	file: string;
	bytes: number;
	source?: string;
	tables?: number;
	rows?: number;
	media?: { copied: number; preserved: number; total: number; pending?: number };
	uploads?: { copied: number; preserved: number; total: number; pending?: number };
}

export interface UndoPoint {
	bookmark: string;
	rewoundAt: string;
	rewoundTo: string;
}

export interface ListResponse {
	items: Backup[];
	scheduled: boolean;
	retentionDays: number;
	staleAfterHours: number;
	restore: { enabled: true } | { enabled: false; reason: string };
	undo: UndoPoint | null;
}

export function ago(iso: string): string {
	const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
	if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
	if (hours < 48) return `${Math.round(hours)} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

export function sourceLabel(source?: string): string {
	if (source === "admin") return "Manual";
	if (source === "scheduled") return "Scheduled";
	return "Nightly job";
}

export function useBackups() {
	const [data, setData] = React.useState<ListResponse>();
	const [error, setError] = React.useState<string>();
	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			setData(await parseApiResponse<ListResponse>(await apiFetch(`${BACKUPS_API}/list`), "Could not load backups"));
		} catch (cause) {
			setError(errorText(cause, "Could not load backups"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);
	return { data, error, load };
}

export function isStale(data: ListResponse): boolean {
	const latest = data.items[0];
	return !latest || (Date.now() - new Date(latest.createdAt).getTime()) / 3_600_000 > data.staleAfterHours;
}

export function BackupStatusWidget() {
	const { data, error } = useBackups();
	if (error) return <p className="text-sm text-kumo-danger">{error}</p>;
	if (!data) return <Loading className="" label="Loading backups…" />;
	const latest = data.items[0];
	if (!latest) return <p className="text-sm text-kumo-danger">No backups yet.</p>;
	return (
		<div className="space-y-1 text-sm">
			<p className={isStale(data) ? "font-medium text-kumo-danger" : "font-medium"}>Last backup {ago(latest.createdAt)}</p>
			<p className="text-kumo-subtle">
				{sourceLabel(latest.source)} · {data.items.length} kept
			</p>
		</div>
	);
}


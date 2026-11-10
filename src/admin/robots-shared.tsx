/** Helpers shared by the Robots.txt admin page, its rule dialog and its Bots tab. */
import { Badge } from "@cloudflare/kumo";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import * as React from "react";

import { apiGet, apiPost, errorText } from "./api.js";
import type { BotEntry } from "../robots/bots.js";

export const API = "/_emdash/api/plugins/coywolf-pack/robots";

export const post = apiPost(API);
export const get = apiGet(API);

export const newId = () => Math.random().toString(36).slice(2, 10);
export const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
export const dateTimeFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** Token → entry; when several bots share a token, a verified entry wins. */
export function tokenIndex(bots: BotEntry[]): Map<string, BotEntry> {
	const map = new Map<string, BotEntry>();
	for (const b of bots) {
		const key = b.token.toLowerCase();
		const have = map.get(key);
		if (!have || (have.status !== "verified" && b.status === "verified")) map.set(key, b);
	}
	return map;
}

export const EVIDENCE_LABELS: Record<string, string> = {
	"operator-docs": "Operator's documentation",
	"user-agent": "Published user-agent string",
	manual: "Verified on this site",
	heuristic: "Derived from Cloudflare Radar",
	none: "Not checked",
};

/**
 * A bot's verification status. The evidence (for verified bots) and the note
 * (for unverified ones) are shown as text, not only in a hover title, so
 * keyboard and touch users see them too. Pass `evidence={false}` where the
 * evidence is already shown next to it.
 */
export function StatusBadge({ bot, evidence = true }: { bot: BotEntry; evidence?: boolean }) {
	if (bot.origin === "custom" && bot.status !== "verified") return <Badge variant="outline">custom</Badge>;
	if (bot.status === "verified") {
		const label = EVIDENCE_LABELS[bot.evidence];
		return (
			<span className="inline-flex items-center gap-1 text-xs text-kumo-subtle" title={label ?? "Verified"}>
				<CheckCircle className="text-kumo-success" aria-hidden="true" />
				<span>verified</span>
				{evidence && label && <span>· {label}</span>}
			</span>
		);
	}
	return (
		<span className="inline-flex flex-wrap items-center gap-1" title={bot.note ?? "This token hasn't been confirmed in the operator's documentation."}>
			<Badge variant="warning">unverified</Badge>
			{bot.note && <span className="text-xs text-kumo-subtle">{bot.note}</span>}
		</span>
	);
}

export function UnverifiedIcon() {
	return <WarningCircle className="text-kumo-warning" role="img" aria-label="unverified" />;
}

/** A checkbox that can show "some selected". */
export function TriCheckbox(props: { checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void; label: string; id?: string }) {
	const ref = React.useRef<HTMLInputElement>(null);
	React.useEffect(() => {
		if (ref.current) ref.current.indeterminate = props.indeterminate;
	}, [props.indeterminate]);
	return (
		<input
			ref={ref}
			id={props.id}
			type="checkbox"
			className="size-4 shrink-0 cw-accent-current"
			checked={props.checked}
			aria-checked={props.indeterminate ? "mixed" : props.checked}
			aria-label={props.label}
			onChange={(e) => props.onChange(e.target.checked)}
		/>
	);
}

/** Copy text to the clipboard with an announced result. */
export function useCopy(): [string, (text: string) => void] {
	const [status, setStatus] = React.useState("");
	const copy = (text: string) => {
		void navigator.clipboard
			.writeText(text)
			.then(() => setStatus("Copied"))
			.catch(() => setStatus("Copy failed"))
			.finally(() => window.setTimeout(() => setStatus(""), 2000));
	};
	return [status, copy];
}

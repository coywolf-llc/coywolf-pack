/**
 * "Coywolf Pack x.y.z is available": a card on EmDash's dashboard (listed by
 * the server only while an update is waiting) and a notice at the top of
 * every pack page (packPage in page.tsx), each with the command to install it. The server asks npm
 * at most once a day; the pages read the answer once per admin visit.
 * Dismissing hides both for everyone on the site until a newer version.
 */
import { Banner, Button } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { UpdateStatus } from "../updates/check.js";

const API = "/_emdash/api/plugins/coywolf-pack/updates";
const CHANGED_EVENT = "coywolf-pack:update-changed";

type Available = Extract<UpdateStatus, { enabled: true }> & { latest: string };

/** One request per admin visit (the admin is a single-page app). */
let pending: Promise<UpdateStatus | null> | null = null;
function loadStatus(): Promise<UpdateStatus | null> {
	// Not an admin, the module left out, or offline: no notice for this visit.
	pending ??= apiFetch(`${API}/status`)
		.then((response) => parseApiResponse<UpdateStatus>(response, "Couldn't check for updates"))
		.catch(() => null);
	return pending;
}

/** Ask again (after Update check is switched on or off): the notices on the page refresh. */
export function resetUpdateStatus(): void {
	pending = null;
	window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** The EmDash admin's query client, to refresh the dashboard after a dismissal (null if unavailable). */
function useAdminQueryClient() {
	try {
		return useQueryClient();
	} catch {
		return null;
	}
}

function useUpdate(options: { reloadAfterDismiss?: boolean } = {}): { status: UpdateStatus | null; loaded: boolean; update: Available | null; dismiss: () => Promise<void>; error: string | null } {
	const queryClient = useAdminQueryClient();
	const [status, setStatus] = React.useState<UpdateStatus | null>(null);
	const [loaded, setLoaded] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	React.useEffect(() => {
		let live = true;
		const read = () =>
			void loadStatus().then((s) => {
				if (!live) return;
				setStatus(s);
				setLoaded(true);
			});
		read();
		// A dismissal in one notice hides the others on the page.
		window.addEventListener(CHANGED_EVENT, read);
		return () => {
			live = false;
			window.removeEventListener(CHANGED_EVENT, read);
		};
	}, []);
	const update = status?.enabled && status.available && !status.dismissed && status.latest ? (status as Available) : null;
	const dismiss = async () => {
		if (!update) return;
		setError(null);
		try {
			const response = await apiFetch(`${API}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ version: update.latest }),
			});
			await parseApiResponse(response, "Couldn't dismiss the notice");
			pending = Promise.resolve({ ...update, dismissed: true });
			window.dispatchEvent(new Event(CHANGED_EVENT));
			// The dashboard card is listed by the admin manifest: refresh it so the card goes. EmDash's admin
			// keeps its own copy of React Query, so its client may be out of reach: then reload, like the Features page.
			if (queryClient) void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			else if (options.reloadAfterDismiss) window.location.reload();
		} catch (cause) {
			setError(cause instanceof Error && cause.message ? cause.message : "Couldn't dismiss the notice");
		}
	};
	return { status, loaded, update, dismiss, error };
}

/** Copies the command; if the browser refuses, selects it so ⌘C or Ctrl+C copies it. */
function useCopyCommand(): [string, React.RefObject<HTMLElement | null>, (text: string) => void] {
	const [status, setStatus] = React.useState("");
	const ref = React.useRef<HTMLElement | null>(null);
	const timer = React.useRef<number | undefined>(undefined);
	React.useEffect(() => () => window.clearTimeout(timer.current), []);
	const copy = (text: string) => {
		const done = (message: string) => {
			setStatus(message);
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setStatus(""), 4000);
		};
		const select = () => {
			const selection = window.getSelection();
			if (ref.current && selection) {
				selection.selectAllChildren(ref.current);
				done("Couldn't copy: the command is selected, press ⌘C or Ctrl+C");
			} else done("Couldn't copy");
		};
		if (!navigator.clipboard?.writeText) return select();
		navigator.clipboard.writeText(text).then(() => done("Copied"), select);
	};
	return [status, ref, copy];
}

/** The command and actions, shared by the dashboard card and the page notice. */
function UpdateDetails(props: { update: Available; dismiss: () => Promise<void>; error: string | null }) {
	const { update } = props;
	const [copied, commandRef, copy] = useCopyCommand();
	const [dismissing, setDismissing] = React.useState(false);
	return (
		<div className="space-y-3">
			<p>
				This site runs {update.current}. In the site's folder, run this command, then deploy. Updating never turns features on by
				itself.
			</p>
			<pre className="cw-overflow-auto rounded-md border border-kumo-line px-3 py-2 font-mono text-sm">
				<code ref={commandRef}>{update.command}</code>
			</pre>
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="secondary" size="sm" onClick={() => copy(update.command)}>
					Copy command
				</Button>
				<a className="text-kumo-link hover:underline" href={update.releasesUrl} target="_blank" rel="noopener noreferrer">
					What's new<span className="sr-only"> (opens in a new tab)</span>
				</a>
				<Button
					variant="ghost"
					size="sm"
					disabled={dismissing}
					onClick={() => {
						setDismissing(true);
						void props.dismiss().finally(() => setDismissing(false));
					}}
				>
					Dismiss
				</Button>
				<span role="status" aria-live="polite" className="text-sm text-kumo-subtle">
					{props.error ?? copied}
				</span>
			</div>
		</div>
	);
}

/** The notice at the top of a pack page. */
export function UpdateNotice() {
	const { update, dismiss, error } = useUpdate();
	if (!update) return null;
	return (
		<div style={{ marginBottom: "1.5rem" }}>
			<Banner title={`Coywolf Pack ${update.latest} is available`} description={<UpdateDetails update={update} dismiss={dismiss} error={error} />} />
		</div>
	);
}

/** The dashboard card (EmDash lists it only while an update is waiting). */
export function UpdateWidget() {
	const { status, loaded, update, dismiss, error } = useUpdate({ reloadAfterDismiss: true });
	if (!loaded) return null;
	if (!update) {
		// Listed only while an update is waiting: an editor can't read the details (admins only); an admin just dismissed it.
		return (
			<p className="text-sm text-kumo-subtle">
				{status ? "Dismissed. This card goes away the next time the dashboard loads." : "A Coywolf Pack update is waiting. An administrator can install it."}
			</p>
		);
	}
	return (
		<div className="space-y-3 text-sm">
			<h3 className="text-base font-semibold">Coywolf Pack {update.latest} is available</h3>
			<UpdateDetails update={update} dismiss={dismiss} error={error} />
		</div>
	);
}

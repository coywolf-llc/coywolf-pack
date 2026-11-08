/**
 * "Coywolf Pack x.y.z is available": at the top of every pack page (with the
 * command to install it) and in the Cloudflare usage dashboard widget (a
 * line linking to it). The server asks npm at most once a day; the answer is
 * read once per admin visit. Dismissing hides the notice in this browser
 * until a newer version comes out.
 */
import { Banner, Button } from "@cloudflare/kumo";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { UpdateStatus } from "../updates/check.js";

const API = "/_emdash/api/plugins/coywolf-pack/updates/status";
const ADMIN = "/_emdash/admin";
const DISMISSED_KEY = "coywolf-pack:update-dismissed";
const DISMISSED_EVENT = "coywolf-pack:update-dismissed";

type Available = Extract<UpdateStatus, { enabled: true }> & { latest: string };

/** One request per admin visit (the admin is a single-page app); a failure is retried on the next page. */
let pending: Promise<UpdateStatus | null> | null = null;
function loadStatus(): Promise<UpdateStatus | null> {
	pending ??= apiFetch(API)
		.then((response) => parseApiResponse<UpdateStatus>(response, "Couldn't check for updates"))
		.catch(() => {
			pending = null;
			// Not an admin, an older server, or offline: no notice.
			return null;
		});
	return pending;
}

function dismissedVersion(): string | null {
	try {
		return window.localStorage.getItem(DISMISSED_KEY);
	} catch {
		return null;
	}
}

function useUpdate(): [Available | null, () => void] {
	const [status, setStatus] = React.useState<UpdateStatus | null>(null);
	const [dismissed, setDismissed] = React.useState<string | null>(() => dismissedVersion());
	React.useEffect(() => {
		let live = true;
		void loadStatus().then((s) => {
			if (live) setStatus(s);
		});
		// Dismissing in one notice hides the others on the page.
		const sync = () => setDismissed(dismissedVersion());
		window.addEventListener(DISMISSED_EVENT, sync);
		return () => {
			live = false;
			window.removeEventListener(DISMISSED_EVENT, sync);
		};
	}, []);
	const update = status?.enabled && status.available && status.latest && status.latest !== dismissed ? (status as Available) : null;
	const dismiss = () => {
		if (!update) return;
		try {
			window.localStorage.setItem(DISMISSED_KEY, update.latest);
		} catch {
			// Private browsing: hidden until the page reloads.
		}
		setDismissed(update.latest);
		window.dispatchEvent(new Event(DISMISSED_EVENT));
	};
	return [update, dismiss];
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

/** The full notice, for the top of a pack page. */
export function UpdateNotice() {
	const [update, dismiss] = useUpdate();
	const [copied, commandRef, copy] = useCopyCommand();
	if (!update) return null;
	return (
		<div style={{ marginBottom: "1.5rem" }}>
			<Banner
				title={`Coywolf Pack ${update.latest} is available`}
				description={
					<div className="space-y-3">
						<p>
							This site runs {update.current}. In the site's folder, run this command, then deploy. Updating never turns features
							on by itself.
						</p>
						<pre className="cw-overflow-auto rounded-md border border-kumo-line px-3 py-2 font-mono text-sm">
							<code ref={commandRef}>{update.command}</code>
						</pre>
						<div className="flex flex-wrap items-center gap-2">
							<Button variant="secondary" size="sm" onClick={() => copy(update.command)}>
								Copy command
							</Button>
							<a className="text-kumo-link hover:underline" href={update.releasesUrl} target="_blank" rel="noopener noreferrer">
								What's new
							</a>
							<Button variant="ghost" size="sm" onClick={dismiss}>
								Dismiss
							</Button>
							<span role="status" aria-live="polite" className="text-sm text-kumo-subtle">
								{copied}
							</span>
						</div>
					</div>
				}
			/>
		</div>
	);
}

/** One line for a dashboard widget, linking to the full notice. */
export function UpdateLine() {
	const [update] = useUpdate();
	if (!update) return null;
	return (
		<p className="mb-3 text-sm">
			<span className="font-medium">Coywolf Pack {update.latest} is available.</span>{" "}
			<a className="text-kumo-link hover:underline" href={`${ADMIN}/plugins/coywolf-pack/features`}>
				How to update
			</a>
		</p>
	);
}

/** A pack page with the notice above it. */
export function withUpdateNotice(Page: React.ComponentType): React.ComponentType {
	function PageWithUpdateNotice() {
		return (
			<>
				<UpdateNotice />
				<Page />
			</>
		);
	}
	PageWithUpdateNotice.displayName = `WithUpdateNotice(${Page.displayName ?? Page.name ?? "Page"})`;
	return PageWithUpdateNotice;
}

/** A dashboard widget with the one-line notice above it. */
export function withUpdateLine(Widget: React.ComponentType): React.ComponentType {
	function WidgetWithUpdateLine() {
		return (
			<>
				<UpdateLine />
				<Widget />
			</>
		);
	}
	WidgetWithUpdateLine.displayName = `WithUpdateLine(${Widget.displayName ?? Widget.name ?? "Widget"})`;
	return WidgetWithUpdateLine;
}

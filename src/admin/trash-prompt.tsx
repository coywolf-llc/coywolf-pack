/**
 * The trash prompt (feature "redirects.trashPrompt"): right after an editor
 * trashes or unpublishes published entries anywhere in the admin, ask what
 * their old URLs should do. Mounted once, in its own React root, by the
 * admin module (index.tsx). Decide later (or Escape) leaves them listed under
 * Plugins → Redirects → Removed content. See trash-prompt-core.ts for how
 * removals are noticed.
 */
import { Banner, Button, Dialog } from "@cloudflare/kumo";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";
import { createRoot } from "react-dom/client";

import { errorText } from "./api.js";
import { REMOVED_API, RedirectDialog, RemovedItemRow, resolve } from "./redirects-removed.js";
import { type Pending, collectRemovals, watchContentRemovals } from "./trash-prompt-core.js";

let push: ((items: Pending[]) => void) | null = null;
const early: Pending[][] = [];

async function fetchPending(): Promise<Pending[] | null> {
	const response = await apiFetch(REMOVED_API);
	if (!response.ok) return null; // 404: feature off; 403: can't manage plugins.
	return (await parseApiResponse<{ items: Pending[] }>(response, "Could not load removed content")).items;
}

function TrashPrompt() {
	const [items, setItems] = React.useState<Pending[]>([]);
	const [status, setStatus] = React.useState<Record<string, string>>({});
	const [busy, setBusy] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string>();
	const [redirecting, setRedirecting] = React.useState<Pending | null>(null);
	const firstButton = React.useRef<HTMLButtonElement>(null);
	const doneButton = React.useRef<HTMLButtonElement>(null);
	const open = items.length > 0;

	React.useEffect(() => {
		push = (found) =>
			setItems((current) => [...current, ...found.filter((item) => !current.some((c) => c.id === item.id))]);
		for (const found of early.splice(0)) push(found);
		return () => {
			push = null;
		};
	}, []);

	// Focus the first "Redirect to…" once the dialog has opened (it focuses itself first).
	React.useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => firstButton.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, [open]);

	// After a decision its buttons go away: move focus to the next undecided entry, or to Done.
	const decided = Object.keys(status).length;
	React.useEffect(() => {
		if (!decided) return;
		const timer = setTimeout(() => (firstButton.current ?? doneButton.current)?.focus(), 50);
		return () => clearTimeout(timer);
	}, [decided]);

	const close = () => {
		setItems([]);
		setStatus({});
		setError(undefined);
		setRedirecting(null);
	};

	const gone = async (item: Pending) => {
		setBusy(item.id);
		setError(undefined);
		try {
			await resolve(item.id, "gone");
			setStatus((s) => ({ ...s, [item.id]: `${item.url} now returns 410 Gone.` }));
		} catch (cause) {
			setError(errorText(cause, "The request failed"));
		} finally {
			setBusy(null);
		}
	};

	const one = items.length === 1 ? items[0] : null;
	const settled = open && items.every((item) => status[item.id]);
	const firstOpen = items.find((item) => !status[item.id]);

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !next && busy === null && close()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">
					{one ? "What should the old URL do?" : "What should the old URLs do?"}
				</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					{one ? (
						<>
							“{one.title}” was live at <code>{one.url}</code>.{settled ? "" : " Until you decide, that URL returns 404."}
						</>
					) : (
						`These ${items.length} entries were live.${settled ? "" : " Until you decide, their URLs return 404."}`
					)}
				</Dialog.Description>
				<ul className="mt-4 max-h-80 divide-y divide-kumo-line overflow-y-auto rounded-lg border border-kumo-line" aria-live="polite">
					{items.map((item) => (
						<RemovedItemRow
							key={item.id}
							item={item}
							busy={busy !== null}
							status={status[item.id]}
							redirectRef={item === firstOpen ? firstButton : undefined}
							onRedirect={() => setRedirecting(item)}
							onGone={() => void gone(item)}
						/>
					))}
				</ul>
				{error && (
					<div className="mt-4">
						<Banner variant="error" role="alert" description={error} />
					</div>
				)}
				<div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
					<p className="flex-1 text-xs text-kumo-subtle">
						{settled ? "" : "You can decide any time under Plugins → Redirects → Removed content."}
					</p>
					<Button ref={doneButton} variant={settled ? "primary" : "secondary"} disabled={busy !== null} onClick={close}>
						{settled ? "Done" : "Decide later"}
					</Button>
				</div>
				<RedirectDialog
					item={redirecting}
					onClose={() => setRedirecting(null)}
					onDone={(message) => {
						const item = redirecting;
						setRedirecting(null);
						if (item) setStatus((s) => ({ ...s, [item.id]: message }));
					}}
				/>
			</Dialog>
		</Dialog.Root>
	);
}

/** Start watching for removals and mount the prompt (browser only, once). */
export function mountTrashPrompt(): void {
	if (typeof window === "undefined" || typeof document === "undefined") return;
	const removed = collectRemovals({
		fetchPending,
		onReady: (found) => (push ? push(found) : early.push(found)),
	});
	if (!watchContentRemovals(removed, window)) return;
	const mount = () => {
		if (document.getElementById("cw-trash-prompt")) return;
		const host = document.createElement("div");
		host.id = "cw-trash-prompt";
		document.body.appendChild(host);
		createRoot(host).render(<TrashPrompt />);
	};
	if (document.body) mount();
	else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

/**
 * The shared "unsaved changes" bar for settings pages: pinned to the bottom of
 * the page's content column (position: sticky inside EmDash's scrolling
 * <main>, so it never covers the sidebar) and shown only while the draft
 * differs from what's saved. Ctrl/⌘+S saves. Leaving the page while dirty
 * asks first: a link to another admin page (or Back) opens EmDash's "Leave
 * without saving?" dialog, through the admin router's blocker as EmDash's
 * own UnsavedChangesGuard does (src/admin/router.ts), and reloading or
 * closing the tab shows the browser's prompt. A failed save's message stays
 * on the bar (`error`, from useSaveResult in toast.tsx).
 *
 * Place it as the LAST child of the page's root container. For a <form>,
 * give the form an id and pass it as `form`: Save becomes that form's submit
 * button (so Enter in a field still submits and native validation runs).
 * Because it's sticky rather than fixed, it takes its own space at the end of
 * the page and never hides the last field.
 */
import { Button } from "@cloudflare/kumo";
import { FloppyDisk } from "@phosphor-icons/react";
import * as React from "react";

import { SAVE_BAR_CSS } from "./admin-css.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { adminRouter, guardNavigation, leaveQuestions } from "./router.js";

export { isDirty } from "./dirty.js";

/**
 * While `dirty`: ask before leaving the page, and Ctrl/⌘+S calls `onSave`
 * (when `canSave`). Returns the "Leave without saving?" dialog, to render.
 * The browser's own Save dialog is suppressed whenever the page is mounted,
 * dirty or not.
 */
export function useUnsavedChanges(dirty: boolean, onSave: () => void, canSave = true): React.ReactNode {
	const latest = React.useRef({ dirty, onSave, canSave });
	latest.current = { dirty, onSave, canSave };

	React.useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	// In-app navigation (the sidebar, links, Back and Forward): the admin router's blocker, answered in the dialog below.
	const [asking, setAsking] = React.useState<{ answer: (leave: boolean) => void } | null>(null);
	React.useEffect(() => {
		if (!dirty) return;
		const router = adminRouter();
		if (!router) return;
		const questions = leaveQuestions((answer) => setAsking(answer ? { answer } : null));
		const release = guardNavigation(router, () => questions.ask());
		return () => {
			release();
			// Saved or discarded while the dialog was open: nothing would be lost now.
			questions.settle(true);
		};
	}, [dirty]);

	React.useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
			event.preventDefault();
			const { dirty: isDirtyNow, onSave: save, canSave: ok } = latest.current;
			if (isDirtyNow && ok && !event.repeat) save();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<ConfirmDialog
			open={asking !== null}
			title="Leave without saving?"
			description="Your unsaved changes will be lost."
			confirmLabel="Leave"
			cancelLabel="Stay"
			onConfirm={() => asking?.answer(true)}
			onClose={() => asking?.answer(false)}
		/>
	);
}

export function SaveBar(props: {
	dirty: boolean;
	saving: boolean;
	/** False when the draft is invalid (the page's own validity rules). */
	canSave?: boolean;
	/** Called by Save and Ctrl/⌘+S. With `form`, that form is submitted instead (its onSubmit saves). */
	onSave?: () => void;
	onDiscard: () => void;
	/** Extra context after "Unsaved changes", e.g. what saving also does. */
	detail?: React.ReactNode;
	/** Label for the Save button (default "Save"). */
	label?: string;
	/** Id of the <form> whose submit button Save is. */
	form?: string;
	/** Why the last save failed (useSaveResult().error): shown on the bar until the next save. */
	error?: string | null;
}) {
	const canSave = props.canSave ?? true;
	const { onSave, form, saving } = props;
	const save = React.useCallback(() => {
		if (saving) return;
		if (form) (document.getElementById(form) as HTMLFormElement | null)?.requestSubmit();
		else onSave?.();
	}, [onSave, form, saving]);
	const leaveDialog = useUnsavedChanges(props.dirty, save, canSave);

	// Sticky bottom: 0 stops at the top of the scroll container's bottom padding
	// (EmDash's <main> has p-6), leaving a strip of page showing under the bar.
	// Offset by that padding so the bar sits flush with the bottom edge.
	const bar = React.useRef<HTMLDivElement>(null);
	const [offset, setOffset] = React.useState(0);
	React.useLayoutEffect(() => {
		if (!props.dirty || !bar.current) return;
		let node: HTMLElement | null = bar.current.parentElement;
		while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
		setOffset(node ? Number.parseFloat(getComputedStyle(node).paddingBottom) || 0 : 0);
	}, [props.dirty]);

	return (
		<>
			{/* Always rendered so the change is announced when the bar appears. */}
			<p className="sr-only" role="status" aria-live="polite">
				{props.dirty ? "Unsaved changes" : ""}
			</p>
			{leaveDialog}
			{props.dirty && (
				<div
					ref={bar}
					className="cw-save-bar flex flex-wrap items-center justify-between gap-3 border border-kumo-line bg-kumo-base"
					role="region"
					aria-label="Unsaved changes"
					style={{
						position: "sticky",
						bottom: -offset,
						zIndex: 20,
						borderBottom: "none",
						borderTopLeftRadius: 8,
						borderTopRightRadius: 8,
						padding: "12px 16px",
						paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
						boxShadow: "0 -4px 12px -6px rgba(0, 0, 0, 0.18)",
					}}
				>
					<style>{SAVE_BAR_CSS}</style>
					<div className="min-w-0 text-sm">
						<span className="font-medium">Unsaved changes</span>
						{props.detail && <span className="text-kumo-subtle"> · {props.detail}</span>}
						{props.error && <p className="mt-1 text-kumo-danger">{props.error}</p>}
					</div>
					<div className="flex shrink-0 gap-2">
						<Button type="button" variant="secondary" disabled={props.saving} onClick={props.onDiscard}>
							Discard
						</Button>
						<Button
							type={form ? "submit" : "button"}
							form={form}
							variant="primary"
							icon={<FloppyDisk />}
							disabled={props.saving || !canSave}
							onClick={form ? undefined : save}
						>
							{props.saving ? "Saving…" : (props.label ?? "Save")}
						</Button>
					</div>
				</div>
			)}
		</>
	);
}

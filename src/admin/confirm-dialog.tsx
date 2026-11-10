/**
 * Confirmations, in place of the browser's confirm(): EmDash's ConfirmDialog
 * (same props and wording rules), which EmDash doesn't export to plugins,
 * built on PackDialog so it follows EmDash to LayerDialog in one place.
 *
 * Focus starts on the safe choice (Cancel, or the cancelLabel), the backdrop
 * doesn't dismiss it, and a destructive action gets the destructive style.
 * With isPending, the dialog stays open and can't be dismissed while the
 * action runs; an error shows inside it.
 */
import * as React from "react";

import { PackDialog } from "./dialog.js";

export interface ConfirmDialogProps {
	open: boolean;
	onClose: () => void;
	title: string;
	description?: React.ReactNode;
	/** The action, as a verb: "Delete", "Turn off", "Replace". */
	confirmLabel: string;
	/** Default "Cancel". */
	cancelLabel?: string;
	/** Shown on the action while isPending (default the confirm label). */
	pendingLabel?: string;
	/** Default "destructive". Use "primary" for an action that loses nothing. */
	variant?: "destructive" | "primary";
	confirmDisabled?: boolean;
	isPending?: boolean;
	/** An error from the action: shown in the dialog, which stays open. */
	error?: string | null;
	onConfirm: () => void;
	/** Extra content between the description and the buttons. */
	children?: React.ReactNode;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
	const pending = props.isPending ?? false;
	return (
		<PackDialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()} dismissDisabled={pending} disablePointerDismissal>
			<PackDialog.Content size="sm">
				<PackDialog.Title>{props.title}</PackDialog.Title>
				{props.description && <PackDialog.Description>{props.description}</PackDialog.Description>}
				{(props.children || props.error) && (
					<PackDialog.Body>
						{props.children}
						{props.error && (
							<div role="alert" className="rounded-md bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
								{props.error}
							</div>
						)}
					</PackDialog.Body>
				)}
				<PackDialog.Actions dismissLabel={props.cancelLabel ?? "Cancel"}>
					<PackDialog.Action variant={props.variant ?? "destructive"} disabled={pending || props.confirmDisabled} onClick={props.onConfirm}>
						{pending ? (props.pendingLabel ?? props.confirmLabel) : props.confirmLabel}
					</PackDialog.Action>
				</PackDialog.Actions>
			</PackDialog.Content>
		</PackDialog.Root>
	);
}

export type ConfirmOptions = Pick<ConfirmDialogProps, "title" | "description" | "confirmLabel" | "cancelLabel" | "variant">;

/**
 * `const [confirm, confirmDialog] = useConfirm()`: render `confirmDialog`
 * once, then `if (!(await confirm({ title, confirmLabel }))) return;` where
 * the page used `window.confirm`. Resolves false when dismissed (or when the
 * page goes away while it's open).
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
	const [request, setRequest] = React.useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
	const pending = React.useRef<((ok: boolean) => void) | null>(null);

	const confirm = React.useCallback(
		(options: ConfirmOptions) =>
			new Promise<boolean>((resolve) => {
				// A second question replaces an unanswered one (which then counts as Cancel).
				pending.current?.(false);
				pending.current = resolve;
				setRequest({ options, resolve });
			}),
		[],
	);

	React.useEffect(() => () => pending.current?.(false), []);

	const answer = (ok: boolean) => {
		request?.resolve(ok);
		pending.current = null;
		setRequest(null);
	};

	// The last question stays on screen while the dialog closes.
	const last = React.useRef<ConfirmOptions | null>(null);
	if (request) last.current = request.options;
	const options = request?.options ?? last.current;

	const dialog = (
		<ConfirmDialog
			open={request !== null}
			title={options?.title ?? ""}
			description={options?.description}
			confirmLabel={options?.confirmLabel ?? "OK"}
			cancelLabel={options?.cancelLabel}
			variant={options?.variant}
			onConfirm={() => answer(true)}
			onClose={() => answer(false)}
		/>
	);
	return [confirm, dialog];
}

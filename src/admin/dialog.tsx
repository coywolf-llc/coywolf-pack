/**
 * PackDialog: the parts of Kumo's LayerDialog the pack's dialogs use, built
 * on Kumo 2.6's Dialog (the version EmDash 1.4 pins).
 *
 * EmDash's next release moves its admin to Kumo 2.15 and its dialogs to
 * LayerDialog (a fixed title, an action tray, bottom sheets on phones).
 * PackDialog has LayerDialog's structure and props (Root or Alert, Content,
 * Title, Description, Body, Actions with one Action), so once the sites run
 * Kumo 2.15 this file becomes a re-export of LayerDialog and every pack
 * dialog that uses it follows, with no page changes.
 *
 * As in LayerDialog, Actions renders the dismiss button itself, before the
 * action, so it's the first button in the dialog: focus starts on the safe
 * choice (Kumo's Dialog focuses the first focusable element when it opens).
 */
import { Button, Dialog } from "@cloudflare/kumo";
import * as React from "react";

interface RootProps {
	open: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Refuse every dismissal (Escape, the backdrop, the dismiss button) while work is pending. */
	dismissDisabled?: boolean;
	/** Clicking the backdrop doesn't close it (destructive confirmations). */
	disablePointerDismissal?: boolean;
	children: React.ReactNode;
}

const DismissContext = React.createContext<{ dismiss: () => void; disabled: boolean }>({ dismiss: () => undefined, disabled: false });

function Root(props: RootProps & { role?: "dialog" | "alertdialog" }) {
	const { onOpenChange, dismissDisabled = false } = props;
	const dismiss = React.useCallback(() => {
		if (!dismissDisabled) onOpenChange?.(false);
	}, [onOpenChange, dismissDisabled]);
	const value = React.useMemo(() => ({ dismiss, disabled: dismissDisabled }), [dismiss, dismissDisabled]);
	const change = (open: boolean) => {
		if (!open && dismissDisabled) return;
		onOpenChange?.(open);
	};
	return (
		<DismissContext.Provider value={value}>
			{props.role === "alertdialog" ? (
				<Dialog.Root role="alertdialog" open={props.open} onOpenChange={change}>
					{props.children}
				</Dialog.Root>
			) : (
				<Dialog.Root open={props.open} onOpenChange={change} disablePointerDismissal={props.disablePointerDismissal}>
					{props.children}
				</Dialog.Root>
			)}
		</DismissContext.Provider>
	);
}

/** A dialog that requires an explicit choice (no backdrop dismissal). */
function Alert(props: RootProps) {
	return <Root {...props} role="alertdialog" />;
}

/** Desktop widths as LayerDialog names them. */
function Content(props: { size?: "sm" | "base" | "lg" | "xl"; children: React.ReactNode }) {
	return (
		<Dialog className="p-6" size={props.size ?? "base"}>
			{props.children}
		</Dialog>
	);
}

function Title(props: { children: React.ReactNode }) {
	return <Dialog.Title className="text-lg font-semibold">{props.children}</Dialog.Title>;
}

function Description(props: { children: React.ReactNode }) {
	return <Dialog.Description className="mt-1 text-sm text-pretty text-kumo-subtle">{props.children}</Dialog.Description>;
}

function Body(props: { children: React.ReactNode }) {
	return <div className="cw-dialog-scroll mt-4 grid gap-3">{props.children}</div>;
}

/** The dismiss button (LayerDialog's automatic one), then the one action. */
function Actions(props: { dismissLabel?: string; children: React.ReactNode }) {
	const { dismiss, disabled } = React.useContext(DismissContext);
	return (
		<div className="mt-6 flex flex-wrap justify-end gap-2">
			<Button type="button" variant="secondary" disabled={disabled} onClick={dismiss}>
				{props.dismissLabel ?? "Close"}
			</Button>
			{props.children}
		</div>
	);
}

function Action(props: Omit<React.ComponentPropsWithoutRef<"button">, "className"> & { variant?: "primary" | "destructive"; loading?: boolean }) {
	const { variant = "primary", loading, type = "button", ...rest } = props;
	return <Button {...rest} type={type} variant={variant} loading={loading} />;
}

export const PackDialog = Object.assign(Root, { Root, Alert, Content, Title, Description, Body, Actions, Action });

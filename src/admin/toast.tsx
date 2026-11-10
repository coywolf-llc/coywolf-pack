/**
 * Save results as toasts, in EmDash's own toast stack (bottom of the
 * screen, next to the pack's Save bar), the way EmDash's settings pages
 * report saves.
 *
 * Plugin pages render inside the admin's <Toasty> provider. If the pack's
 * Kumo isn't the admin's copy (a site that installs a second one), there's no
 * provider for it: packPage then gives the page its own (ToastProvider), so
 * toasts still show.
 */
import { Toasty, useKumoToastManager } from "@cloudflare/kumo";
import * as React from "react";

type Manager = ReturnType<typeof useKumoToastManager>;

/** The toast manager, or null outside a <Toasty> (Kumo's hook throws there). */
function useManager(): Manager | null {
	try {
		return useKumoToastManager();
	} catch {
		return null;
	}
}

/** Gives its children a toast provider when they don't already have one. */
export function ToastProvider(props: { children: React.ReactNode }) {
	return useManager() ? <>{props.children}</> : <Toasty>{props.children}</Toasty>;
}

export interface Toasts {
	success(title: string, description?: React.ReactNode): void;
	error(title: string, description?: React.ReactNode): void;
}

/** Raise a toast. Errors stay longer, so a long message can be read. */
export function useToast(): Toasts {
	const manager = useManager();
	return React.useMemo(
		() => ({
			success: (title, description) => void manager?.add({ title, description, variant: "success", timeout: 4000 }),
			error: (title, description) => void manager?.add({ title, description, variant: "error", timeout: 10_000 }),
		}),
		[manager],
	);
}

/**
 * A settings page's save result: `saved()` raises a success toast; `failed()`
 * an error toast, and keeps the message on the Save bar (pass `error` to
 * SaveBar) until the next save or discard.
 */
export function useSaveResult() {
	const toast = useToast();
	const [error, setError] = React.useState<string | null>(null);
	return React.useMemo(
		() => ({
			error,
			saved(title = "Settings saved", description?: React.ReactNode) {
				setError(null);
				toast.success(title, description);
			},
			failed(message: string, title = "Couldn't save") {
				setError(message);
				toast.error(title, message);
			},
			clear() {
				setError(null);
			},
		}),
		[error, toast],
	);
}

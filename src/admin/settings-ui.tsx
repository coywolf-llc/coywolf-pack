/**
 * Small building blocks for the settings sections on module pages, styled
 * like the AI Enrichment and Schema pages: a bordered section with a title
 * and description, a write-only secret field, and a setup card shown in place
 * of features that need a key first.
 */
import { Button, Input } from "@cloudflare/kumo";
import { Key } from "@phosphor-icons/react";
import * as React from "react";

export function SettingsSection(props: { id: string; title: string; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={props.id}>
			<div className={`flex items-start justify-between gap-4 p-4${props.children ? " border-b border-kumo-line" : ""}`}>
				<div className="min-w-0">
					<h2 id={props.id} className="text-base font-semibold">
						{props.title}
					</h2>
					{props.description && <p className="mt-1 text-sm text-kumo-subtle">{props.description}</p>}
				</div>
				{props.actions && <div className="flex shrink-0 gap-2">{props.actions}</div>}
			</div>
			{props.children && <div className="space-y-4 p-4">{props.children}</div>}
		</section>
	);
}

/**
 * A write-only secret: shows dots when one is saved, and sends a value only
 * when something new is typed. `onClear` offers removing the saved one.
 */
export function SecretField(props: {
	label: string;
	saved: boolean;
	value: string;
	onChange: (value: string) => void;
	description?: string;
	onClear?: () => void;
	clearing?: boolean;
	disabled?: boolean;
}) {
	return (
		<div className="space-y-2">
			<Input
				type="password"
				autoComplete="off"
				label={props.saved ? `${props.label} (saved)` : props.label}
				placeholder={props.saved ? "••••••••••••••••••••••••" : undefined}
				description={props.saved ? "Stored encrypted. Type a new value to replace it." : props.description}
				value={props.value}
				disabled={props.disabled}
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value)}
			/>
			{props.saved && props.onClear && (
				<Button type="button" variant="ghost" size="sm" disabled={props.disabled || props.clearing} onClick={props.onClear}>
					{props.clearing ? "Removing…" : `Remove saved ${props.label.toLowerCase()}`}
				</Button>
			)}
		</div>
	);
}

/** Shown instead of features that need a key or binding that isn't there yet. */
export function SetupCard(props: { title: string; description: React.ReactNode; children?: React.ReactNode }) {
	return (
		<section className="rounded-lg border border-dashed border-kumo-line p-5" aria-label={props.title}>
			<div className="flex items-start gap-3">
				<Key size={22} className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
				<div className="min-w-0 flex-1 space-y-3">
					<div>
						<h2 className="text-base font-semibold">{props.title}</h2>
						<p className="mt-1 text-sm text-pretty text-kumo-subtle">{props.description}</p>
					</div>
					{props.children}
				</div>
			</div>
		</section>
	);
}

/** Parse a number input, keeping `fallback` for anything that isn't a whole number. */
export const wholeNumber = (value: string, fallback: number) => {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
};

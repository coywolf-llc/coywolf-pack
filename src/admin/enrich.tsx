/**
 * The AI Enrich button and its review, in the entry editor's AI suggestions
 * panel (src/admin/editor-panels.tsx AiPanel), since 0.52.0. The run, its
 * store and the wording are in enrich-core.ts; this only draws them.
 *
 * Shown only with EmDash 1.6's `editorDraft` (the panel hides it without one)
 * and when a click could do something (ai/entry's `enrich.available`). A click
 * sends the editor's draft to the pack (admins only, like the panel); nothing
 * changes in the editor until Apply changes in the review.
 */
import { Button, Checkbox } from "@cloudflare/kumo";
import { ArrowClockwise, Sparkle } from "@phosphor-icons/react";
import * as React from "react";

import { PackDialog } from "./dialog.js";
import {
	type EditorDraft,
	type EnrichInfo,
	type RunState,
	applyReview,
	dismissRun,
	explain,
	leftAloneNote,
	operationsToApply,
	plural,
	reviewNote,
	runKey,
	runState,
	setIncludeDescription,
	startRun,
	subscribeRun,
} from "./enrich-core.js";

function Muted(props: { children: React.ReactNode }) {
	return <p className="text-xs leading-4 text-kumo-subtle">{props.children}</p>;
}

/** The entry's run, kept outside the panel (hiding the settings sidebar unmounts it). */
export function useRun(collection: string, entryId: string): [string, RunState] {
	const key = runKey(collection, entryId);
	const subscribe = React.useCallback((listener: () => void) => subscribeRun(key, listener), [key]);
	const read = React.useCallback(() => runState(key), [key]);
	return [key, React.useSyncExternalStore(subscribe, read, read)];
}

export function EnrichButton(props: { collection: string; entryId: string; draft: EditorDraft; info?: EnrichInfo; onApplied: () => void }) {
	const [key, state] = useRun(props.collection, props.entryId);
	const button = React.useRef<HTMLButtonElement>(null);
	const status = React.useRef<HTMLDivElement>(null);
	const running = state.phase === "running";
	const start = () => {
		// The button is disabled while the run lasts: keep focus on the status line it announces in, not the page.
		if (button.current && document.activeElement === button.current) status.current?.focus();
		void startRun(props.collection, props.entryId, props.draft);
	};
	const apply = () => {
		if (applyReview(key, props.draft).phase === "applied") props.onApplied();
	};
	const message = state.phase === "running" ? state.note : state.phase === "applied" || state.phase === "stale" || state.phase === "failed" || state.phase === "done" ? state.message : "";
	return (
		<div className="space-y-1.5">
			<Button ref={button} type="button" size="sm" variant="secondary" icon={<Sparkle aria-hidden="true" />} loading={running} onClick={start}>
				AI Enrich
			</Button>
			{props.info && <Muted>{explain(props.info)}</Muted>}
			<div ref={status} tabIndex={-1} aria-live="polite" className="text-sm">
				{message && <p className={state.phase === "failed" ? "text-kumo-danger" : undefined}>{message}</p>}
			</div>
			{state.phase === "stale" && (
				<Button type="button" size="sm" variant="ghost" icon={<ArrowClockwise aria-hidden="true" />} onClick={start}>
					Run again
				</Button>
			)}
			{state.phase === "review" && (
				<EnrichReview state={state} onApply={apply} onCancel={() => dismissRun(key)} onDescription={(on) => setIncludeDescription(key, on)} onWithoutDescription={() => {
					setIncludeDescription(key, false);
					apply();
				}} />
			)}
		</div>
	);
}

function Section(props: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-1.5">
			<h3 className="text-sm font-semibold">{props.title}</h3>
			{props.children}
		</section>
	);
}

/** The pack's own review of what AI Enrich adds: nothing changes until Apply changes. */
function EnrichReview(props: { state: Extract<RunState, { phase: "review" }>; onApply: () => void; onCancel: () => void; onDescription: (on: boolean) => void; onWithoutDescription: () => void }) {
	const { answer, includeDescription, error, withoutDescription } = props.state;
	const review = answer.review ?? { links: [], possessives: 0, images: [], leftAlone: 0, remaining: 0 };
	const note = reviewNote(answer);
	const ops = operationsToApply(answer, includeDescription);
	return (
		<PackDialog.Root open onOpenChange={(open) => !open && props.onCancel()}>
			<PackDialog.Content size="lg">
				<PackDialog.Title>Review AI Enrich changes</PackDialog.Title>
				<PackDialog.Description>Nothing in the entry changes until you choose Apply changes. Then save or publish as usual.</PackDialog.Description>
				<PackDialog.Body>
					{(review.links.length > 0 || review.possessives > 0) && (
						<Section title={`Links (${review.links.length})`}>
							{review.links.length > 0 && (
								<ul role="list" className="space-y-1 text-sm">
									{review.links.map((link) => (
										<li key={`${link.field}:${link.slug}`} className="min-w-0">
											{link.name}:{" "}
											<a href={link.url} target="_blank" rel="noreferrer noopener" className="break-all text-kumo-link underline">
												{link.url}
												<span className="sr-only"> (opens in a new tab)</span>
											</a>
										</li>
									))}
								</ul>
							)}
							{review.possessives > 0 && <Muted>{`${plural(review.possessives, "possessive")} moved inside ${review.possessives === 1 ? "its" : "their"} link.`}</Muted>}
						</Section>
					)}
					{(review.images.length > 0 || review.leftAlone > 0) && (
						<Section title={`Images (${review.images.length})`}>
							{review.images.length > 0 && (
								<ul role="list" className="space-y-2 text-sm">
									{review.images.map((image, i) => (
										<li key={`${image.field}:${i}`} className="min-w-0">
											<span className="break-all font-medium">{image.filename || "An image"}</span>
											{image.alt && <span className="block">Alt text: {image.alt}</span>}
											{image.caption && <span className="block">Caption: {image.caption}</span>}
										</li>
									))}
								</ul>
							)}
							{review.leftAlone > 0 && <Muted>{leftAloneNote(review.leftAlone)}</Muted>}
						</Section>
					)}
					{review.description && (
						<Section title="Meta description">
							<p className="text-sm">{review.description}</p>
							<Checkbox label="Fill the meta description" checked={includeDescription} onCheckedChange={(on: boolean) => props.onDescription(on)} />
							<Muted>Saved right away, also on a published entry.</Muted>
						</Section>
					)}
					{note && <p className="text-sm">{note}</p>}
					{error && (
						<div role="alert" className="rounded-md bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
							{error}
						</div>
					)}
				</PackDialog.Body>
				<PackDialog.Actions dismissLabel="Cancel">
					{withoutDescription && (
						<Button type="button" variant="secondary" onClick={props.onWithoutDescription}>
							Apply without the meta description
						</Button>
					)}
					<PackDialog.Action variant="primary" disabled={!ops.length} onClick={props.onApply}>
						Apply changes
					</PackDialog.Action>
				</PackDialog.Actions>
			</PackDialog.Content>
		</PackDialog.Root>
	);
}

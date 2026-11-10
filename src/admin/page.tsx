/**
 * What every pack admin page shares: the page wrapper (update notice, error
 * boundary, lazy loading, toasts), the page header, the loading state, and
 * links to other admin pages and to the docs.
 */
import { Banner, Button, Loader } from "@cloudflare/kumo";
import * as React from "react";

import { VERSION } from "../version.js";
import { adminHref, goTo, isPlainClick, packPagePath } from "./router.js";
import { ToastProvider } from "./toast.js";
import { UpdateNotice } from "./update-notice.js";

/** The page header, as EmDash's PageHeader draws it: the title, actions at its end, and a description below. */
export function PageHeader(props: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
	return (
		<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
				<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">{props.title}</h1>
				{props.actions && <div className="flex shrink-0 flex-wrap justify-end gap-2">{props.actions}</div>}
				{props.description && <div className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">{props.description}</div>}
			</div>
		</header>
	);
}

/** A spinner that screen readers announce as `label`. Default layout: centered, with room around it. */
export function Loading(props: { label?: string; className?: string; size?: "sm" | "base" | "lg" }) {
	return (
		<div role="status" className={props.className ?? "flex justify-center py-12"}>
			<span aria-hidden="true" className="inline-flex">
				<Loader size={props.size} />
			</span>
			<span className="sr-only">{props.label ?? "Loading…"}</span>
		</div>
	);
}

interface BoundaryState {
	error: Error | null;
}

/** Keeps a page that throws while rendering from taking the admin down with it: the error shows in its place. */
export class PageErrorBoundary extends React.Component<{ name: string; children: React.ReactNode }, BoundaryState> {
	override state: BoundaryState = { error: null };

	static getDerivedStateFromError(error: unknown): BoundaryState {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	override componentDidCatch(error: unknown) {
		console.error(`coywolf-pack: the ${this.props.name} page failed`, error);
	}

	override render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return (
			<Banner
				variant="error"
				role="alert"
				title={`The ${this.props.name} page couldn't be shown`}
				description={
					<div className="space-y-3">
						<p>{error.message || "Something went wrong."} If it keeps happening, reload the page: a new version of the site may have been deployed.</p>
						<div className="flex flex-wrap gap-2">
							<Button type="button" variant="secondary" size="sm" onClick={() => this.setState({ error: null })}>
								Try again
							</Button>
							<Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>
								Reload the page
							</Button>
						</div>
					</div>
				}
			/>
		);
	}
}

/**
 * A pack page for the admin's page map: loaded on first visit (its own chunk,
 * so the admin doesn't download every page up front), with the update notice
 * above it, an error boundary, and a toast provider when the admin's isn't
 * reachable.
 */
export function packPage(name: string, load: () => Promise<React.ComponentType>): React.ComponentType {
	const Lazy = React.lazy(async () => ({ default: await load() }));
	function PackPage() {
		return (
			<ToastProvider>
				<UpdateNotice />
				<PageErrorBoundary name={name}>
					<React.Suspense fallback={<Loading label={`Loading ${name}…`} />}>
						<Lazy />
					</React.Suspense>
				</PageErrorBoundary>
			</ToastProvider>
		);
	}
	PackPage.displayName = `PackPage(${name})`;
	return PackPage;
}

/** A link to another admin page that stays in the app (no reload), like EmDash's own links. `to` is an admin path ("/redirects"). */
export function AdminLink(props: { to: string; children: React.ReactNode; className?: string }) {
	return (
		<a
			href={adminHref(props.to)}
			className={props.className ?? "text-kumo-link underline"}
			onClick={(event) => {
				if (!isPlainClick(event)) return;
				event.preventDefault();
				goTo(props.to);
			}}
		>
			{props.children}
		</a>
	);
}

/** A link to a pack page ("/features"). */
export function PackLink(props: { page: string; children: React.ReactNode; className?: string }) {
	return (
		<AdminLink to={packPagePath(props.page)} className={props.className}>
			{props.children}
		</AdminLink>
	);
}

/** "the Features page", linked: where every module and part is turned on or off. */
export function FeaturesLink(props: { children?: React.ReactNode }) {
	return <PackLink page="/features">{props.children ?? "the Features page"}</PackLink>;
}

/** The pack's docs on GitHub, at the tag of the running version. */
export const DOCS_BASE = `https://github.com/coywolf-llc/coywolf-pack/blob/v${VERSION}/docs`;

/** A link to one of the pack's docs (`doc` is its file name without .md, plus an optional #anchor). */
export function DocsLink(props: { doc: string; children: React.ReactNode }) {
	const [file, anchor] = props.doc.split("#");
	return (
		<a href={`${DOCS_BASE}/${file}.md${anchor ? `#${anchor}` : ""}`} target="_blank" rel="noreferrer" className="text-kumo-link underline">
			{props.children}
		</a>
	);
}

/**
 * "Removed content" panel on the Redirects page (feature
 * "redirects.trashPrompt"): published entries that were deleted or
 * unpublished, with what to do about their old URLs. Renders nothing while
 * the feature is off.
 */
import { Badge, Banner, Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { ArrowBendUpRight, Prohibit, X } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { errorText } from "./api.js";
import type { Pending } from "./trash-prompt-core.js";

export type { Pending };

export const REMOVED_API = "/_emdash/api/plugins/coywolf-pack/redirects/removed";
const API = REMOVED_API;

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const domId = (item: Pending) => `cw-removed-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/**
 * One removed entry: title, old URL, Deleted/Unpublished badge, and the
 * Redirect to… and Return 410 Gone buttons (plus `extra` buttons and `meta`
 * details). With `status`, the buttons give way to that line.
 */
export function RemovedItemRow(props: {
	item: Pending;
	busy: boolean;
	onRedirect: () => void;
	onGone: () => void;
	meta?: React.ReactNode;
	extra?: React.ReactNode;
	status?: string;
	redirectRef?: React.Ref<HTMLButtonElement>;
}) {
	const { item } = props;
	const urlId = `${domId(item)}-url`;
	return (
		<li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium" title={item.title}>
					{item.title}
				</div>
				<div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
					<code id={urlId} className="truncate" title={item.url}>
						{item.url}
					</code>
					<Badge variant="outline">{item.reason === "deleted" ? "Deleted" : "Unpublished"}</Badge>
					{props.meta}
				</div>
				{props.status && <p className="mt-1 text-sm">{props.status}</p>}
			</div>
			{!props.status && (
				<div className="flex shrink-0 flex-wrap gap-2">
					<Button
						ref={props.redirectRef}
						variant="secondary"
						size="sm"
						icon={<ArrowBendUpRight aria-hidden="true" />}
						disabled={props.busy}
						onClick={props.onRedirect}
						aria-describedby={urlId}
					>
						Redirect to…
					</Button>
					<Button
						variant="secondary"
						size="sm"
						icon={<Prohibit aria-hidden="true" />}
						disabled={props.busy}
						onClick={props.onGone}
						aria-describedby={urlId}
					>
						Return 410 Gone
					</Button>
					{props.extra}
				</div>
			)}
		</li>
	);
}

export function RedirectDialog(props: { item: Pending | null; onClose: () => void; onDone: (message: string) => void }) {
	const [target, setTarget] = React.useState("");
	const [type, setType] = React.useState("301");
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		setTarget("");
		setType("301");
		setError(undefined);
	}, [props.item]);

	const save = async () => {
		if (!props.item) return;
		setPending(true);
		setError(undefined);
		try {
			await resolve(props.item.id, "redirect", target.trim(), Number(type));
			props.onDone(`${props.item.url} now redirects to ${target.trim()}.`);
		} catch (cause) {
			setError(errorText(cause, "Could not create the redirect"));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog.Root open={props.item !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Redirect removed content</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Send visitors and search engines from <code>{props.item?.url}</code> to another page.
				</Dialog.Description>
				<form
					className="mt-4 space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<Input
						label="Destination"
						placeholder="/related-article or https://example.com/page"
						value={target}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTarget(e.target.value)}
						required
					/>
					<Select
						label="Type"
						value={type}
						onValueChange={(value: string | null) => setType(value ?? "301")}
						items={[
							{ value: "301", label: "301 Permanent" },
							{ value: "302", label: "302 Temporary" },
							{ value: "308", label: "308 Permanent (keep method)" },
							{ value: "307", label: "307 Temporary (keep method)" },
						]}
					/>
					{error && <Banner variant="error" role="alert" description={error} />}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" disabled={pending} onClick={props.onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={pending || !target.trim()}>
							{pending ? "Saving…" : "Create redirect"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

export async function resolve(id: string, action: "redirect" | "gone" | "dismiss", target?: string, type?: number) {
	const response = await apiFetch(`${API}/resolve`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id, action, target, type }),
	});
	return parseApiResponse(response, "The request failed");
}

/** Shows pending decisions; calls onRuleCreated after a redirect or 410 rule is added so the page reloads its rules. */
export function RemovedContentPanel(props: { onRuleCreated: () => void }) {
	const [items, setItems] = React.useState<Pending[] | null>(null);
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [redirecting, setRedirecting] = React.useState<Pending | null>(null);
	const [busy, setBusy] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		try {
			const response = await apiFetch(API);
			if (response.status === 404) {
				setItems(null); // Feature off.
				return;
			}
			setItems((await parseApiResponse<{ items: Pending[] }>(response, "Could not load removed content")).items);
		} catch (cause) {
			setError(errorText(cause, "Could not load removed content"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const act = async (item: Pending, action: "gone" | "dismiss") => {
		setBusy(item.id);
		setError(undefined);
		try {
			await resolve(item.id, action);
			setNotice(action === "gone" ? `${item.url} now returns 410 Gone.` : `Dismissed ${item.url}.`);
			if (action === "gone") props.onRuleCreated();
			await load();
		} catch (cause) {
			setError(errorText(cause, "The request failed"));
		} finally {
			setBusy(null);
		}
	};

	if (!items || (items.length === 0 && !notice && !error)) return null;

	return (
		<section aria-labelledby="cw-removed-heading" className="rounded-lg border border-kumo-line">
			<div className="border-b border-kumo-line p-4">
				<h2 id="cw-removed-heading" className="text-base font-semibold">
					Removed content
				</h2>
				<p className="mt-1 text-sm text-kumo-subtle">
					These published entries were deleted or unpublished. Decide what their old URLs should do: redirect them to a
					related page, or tell search engines they're gone for good.
				</p>
			</div>
			<div aria-live="polite">
				{(notice || error) && (
					<div className="space-y-4 p-4">
						{notice && <Banner variant="default" role="status" title={notice} />}
						{error && <Banner variant="error" role="alert" description={error} />}
					</div>
				)}
			</div>
			{items.length === 0 ? (
				<p className="px-4 py-4 text-sm text-kumo-subtle">Nothing left to decide.</p>
			) : (
				<ul className="divide-y divide-kumo-line">
					{items.map((item) => (
						<RemovedItemRow
							key={item.id}
							item={item}
							busy={busy !== null}
							onRedirect={() => setRedirecting(item)}
							onGone={() => void act(item, "gone")}
							meta={<span>{dateFormat.format(new Date(item.at))}</span>}
							extra={
								<Button
									variant="ghost"
									size="sm"
									icon={<X aria-hidden="true" />}
									disabled={busy !== null}
									onClick={() => void act(item, "dismiss")}
									aria-describedby={`${domId(item)}-url`}
								>
									Dismiss
								</Button>
							}
						/>
					))}
				</ul>
			)}
			<RedirectDialog
				item={redirecting}
				onClose={() => setRedirecting(null)}
				onDone={(message) => {
					setRedirecting(null);
					setNotice(message);
					props.onRuleCreated();
					void load();
				}}
			/>
		</section>
	);
}

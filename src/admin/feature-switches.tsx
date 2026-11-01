/**
 * A module's parts (its sub-features) switched on or off from the module's
 * own page, so a part can be turned on where it's set up instead of on the
 * Features page. The module's main switch stays on the Features page (turning
 * it off removes the page from the sidebar). Same routes as the Features
 * page: features/list and features/save.
 */
import { Banner, Switch } from "@cloudflare/kumo";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/coywolf-pack/features";

export interface Part {
	id: string;
	label: string;
	description: string;
	enabled: boolean;
}

interface ModuleState {
	id: string;
	features: Part[];
}

/** Sent after a part is switched, so the page can refresh what depends on it. */
export const FEATURES_CHANGED = "coywolf-pack:features-changed";

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/** The module's main switch and its parts, with a toggle that saves at once. */
export function useParts(moduleId: string) {
	const [main, setMain] = React.useState<Part | null>(null);
	const [parts, setParts] = React.useState<Part[] | null>(null);
	const [saving, setSaving] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		let live = true;
		(async () => {
			try {
				const response = await apiFetch(`${API}/list`);
				const { modules } = await parseApiResponse<{ modules: ModuleState[] }>(response, "Couldn't load the feature switches");
				const [first, ...rest] = modules.find((m) => m.id === moduleId)?.features ?? [];
				if (!live) return;
				setMain(first ?? null);
				setParts(rest);
			} catch (cause) {
				if (live) setError(errorText(cause, "Couldn't load the feature switches"));
			}
		})();
		return () => {
			live = false;
		};
	}, [moduleId]);

	async function toggle(id: string, enabled: boolean) {
		setSaving(id);
		setError(null);
		try {
			const response = await apiFetch(`${API}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ features: { [id]: enabled } }),
			});
			const { features } = await parseApiResponse<{ features: Record<string, boolean> }>(response, "Couldn't save");
			setParts((current) => current?.map((p) => ({ ...p, enabled: features[p.id] ?? p.enabled })) ?? null);
			window.dispatchEvent(new CustomEvent(FEATURES_CHANGED, { detail: features }));
		} catch (cause) {
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(null);
		}
	}

	const isOn = (id: string) => Boolean(main?.enabled && parts?.find((p) => p.id === id)?.enabled);
	return { main, parts, saving, error, toggle, isOn };
}

/** One part's switch (for a page that shows it next to the part's own settings). */
export function PartSwitch(props: { part: Part | undefined; mainOn: boolean; saving: string | null; onToggle: (id: string, on: boolean) => void }) {
	const { part } = props;
	if (!part) return null;
	return (
		<Switch
			size="sm"
			aria-label={`${part.label}: ${part.enabled && props.mainOn ? "on" : "off"}`}
			checked={part.enabled && props.mainOn}
			disabled={props.saving !== null || !props.mainOn}
			transitioning={props.saving === part.id}
			onCheckedChange={(on) => props.onToggle(part.id, on)}
		/>
	);
}

/** A card listing the module's parts with their switches. Nothing when the module has none. */
export function PartSwitches(props: { module: string }) {
	const { main, parts, saving, error, toggle } = useParts(props.module);
	if (error) return <Banner variant="error" role="alert" description={error} />;
	if (!main || !parts?.length) return null;
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={`cw-parts-${props.module}`}>
			<div className="border-b border-kumo-line p-4">
				<h2 id={`cw-parts-${props.module}`} className="text-base font-semibold">
					Turn parts on or off
				</h2>
				<p className="mt-1 text-sm text-kumo-subtle">
					{main.enabled ? "Changes apply right away. The same switches are on the Features page." : `${main.label} is off: turn it on under Plugins → Coywolf Pack → Features first.`}
				</p>
			</div>
			<ul className="divide-y divide-kumo-line">
				{parts.map((part) => (
					<li key={part.id} className="flex items-start justify-between gap-4 px-4 py-3">
						<div className="min-w-0">
							<h3 className="text-sm font-medium">{part.label}</h3>
							<p className="mt-0.5 text-sm text-kumo-subtle">{part.description}</p>
						</div>
						<PartSwitch part={part} mainOn={main.enabled} saving={saving} onToggle={(id, on) => void toggle(id, on)} />
					</li>
				))}
			</ul>
		</section>
	);
}

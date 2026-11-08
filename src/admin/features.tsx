/**
 * Features page: turn each Coywolf Pack module and sub-feature on or off.
 */
import { Banner, Loader, Switch } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { resetUpdateStatus } from "./update-notice.js";


const API = "/_emdash/api/plugins/coywolf-pack/features";

interface Feature {
	id: string;
	label: string;
	description: string;
	enabled: boolean;
}

interface ModuleState {
	id: string;
	label: string;
	features: Feature[];
}

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/** The EmDash admin's query client, so the sidebar can be refreshed (null if unavailable). */
function useAdminQueryClient() {
	try {
		return useQueryClient();
	} catch {
		return null;
	}
}

export function FeaturesPage() {
	const queryClient = useAdminQueryClient();
	const [modules, setModules] = React.useState<ModuleState[] | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [saving, setSaving] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		try {
			const response = await apiFetch(`${API}/list`);
			setModules((await parseApiResponse<{ modules: ModuleState[] }>(response, "Couldn't load features")).modules);
		} catch (cause) {
			setError(errorText(cause, "Couldn't load features"));
		}
	}, []);

	React.useEffect(() => {
		void load();
	}, [load]);

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
			setModules((current) =>
				current?.map((m) => ({ ...m, features: m.features.map((f) => ({ ...f, enabled: features[f.id] ?? f.enabled })) })) ?? null,
			);
			// The update notices ask again whether to show (the dashboard card follows the manifest below).
			if (id === "updates") resetUpdateStatus();
			// A module's pages show in the sidebar only while it's on: refresh the admin manifest.
			if (!id.includes(".")) {
				if (queryClient) void queryClient.invalidateQueries({ queryKey: ["manifest"] });
				else window.location.reload();
			}
		} catch (cause) {
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(null);
		}
	}

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Coywolf Pack</h1>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">
					Turn Coywolf Pack features on or off. A feature that's off stops running everywhere: on the site, in the editor, and in
					scheduled jobs, and its pages leave the sidebar. Its settings and data are kept.
				</p>
			</header>

			{error && <Banner variant="error" role="alert" description={error} />}


			{!modules && !error && (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			)}

			{modules?.map((module) => {
				const [main, ...subs] = module.features;
				if (!main) return null;
				return (
					<section key={module.id} className="rounded-lg border border-kumo-line">
						<div className="flex items-start justify-between gap-4 p-4">
							<div className="min-w-0">
								<h2 className="text-base font-semibold">{main.label}</h2>
								<p className="mt-1 text-sm text-kumo-subtle">{main.description}</p>
							</div>
							<Switch className="shrink-0"
								aria-label={`${main.label}: ${main.enabled ? "on" : "off"}`}
								checked={main.enabled}
								disabled={saving !== null}
								transitioning={saving === main.id}
								onCheckedChange={(on) => void toggle(main.id, on)}
							/>
						</div>
						{subs.length > 0 && (
							<ul className="divide-y divide-kumo-line border-t border-kumo-line">
								{subs.map((feature) => (
									<li key={feature.id} className="flex items-start justify-between gap-4 px-4 py-3 pl-8">
										<div className="min-w-0">
											<h3 className="text-sm font-medium">{feature.label}</h3>
											<p className="mt-0.5 text-sm text-kumo-subtle">{feature.description}</p>
										</div>
										<Switch className="shrink-0"
											size="sm"
											aria-label={`${feature.label}: ${feature.enabled ? "on" : "off"}`}
											checked={feature.enabled && main.enabled}
											disabled={saving !== null || !main.enabled}
											transitioning={saving === feature.id}
											onCheckedChange={(on) => void toggle(feature.id, on)}
										/>
									</li>
								))}
							</ul>
						)}
					</section>
				);
			})}
		</div>
	);
}

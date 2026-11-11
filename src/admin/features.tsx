/**
 * Features page: turn each Coywolf Pack module and sub-feature on or off.
 * The switches edit a draft (src/admin/features-draft.ts); the Save bar saves
 * every change in one request.
 */
import { Banner, Switch } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { CloudflareTokenCard } from "./cloudflare-token-card.js";
import { refreshAdminManifest } from "./extensions.js";
import { useFeatureDraft } from "./features-draft.js";
import { PageHeader, Loading } from "./page.js";
import { SaveBar } from "./save-bar.js";
import { useSaveResult } from "./toast.js";
import { resetUpdateStatus } from "./update-notice.js";

/** The pack's React Query client: the admin's only when both use the same copy (null if not). */
function usePackQueryClient() {
	try {
		return useQueryClient();
	} catch {
		return null;
	}
}

export function FeaturesPage() {
	const queryClient = usePackQueryClient();
	const result = useSaveResult();
	const root = React.useRef<HTMLDivElement>(null);
	const features = useFeatureDraft(
		{
			// A module's pages show in the sidebar only while it's on: refresh the admin manifest, in place.
			refreshManifest: () => {
				if (refreshAdminManifest()) return true;
				if (!queryClient) return false;
				void queryClient.invalidateQueries({ queryKey: ["manifest"] });
				return true;
			},
			// The update notices ask again whether to show (the dashboard card follows the manifest).
			resetUpdates: resetUpdateStatus,
			saved: () => result.saved("Features saved"),
			failed: (message) => result.failed(message),
			clear: () => result.clear(),
		},
		root,
	);
	const { modules, draft, saving } = features;

	return (
		<div ref={root} className="space-y-6">
			<PageHeader
				title="Features"
				description={
					<>
					Turn Coywolf Pack features on or off, then save. A feature that's off stops running everywhere: on the site, in the editor, and in
					scheduled jobs, and its pages leave the sidebar. Its settings and data are kept.
					</>
				}
			/>

			{features.loadError && <Banner variant="error" role="alert" description={features.loadError} />}

			<CloudflareTokenCard />

			{!modules && !features.loadError && (
				<Loading />
			)}

			{draft && modules?.map((module) => {
				const [main, ...subs] = module.features;
				if (!main) return null;
				const mainOn = draft[main.id] ?? false;
				return (
					<section key={module.id} className="rounded-lg border border-kumo-line">
						<div className="flex items-start justify-between gap-4 p-4">
							<div className="min-w-0">
								<h2 className="text-base font-semibold">{main.label}</h2>
								<p className="mt-1 text-sm text-kumo-subtle">{main.description}</p>
							</div>
							<Switch className="shrink-0"
								aria-label={`${main.label}: ${mainOn ? "on" : "off"}`}
								checked={mainOn}
								disabled={saving}
								onCheckedChange={(on) => features.set(main.id, on)}
							/>
						</div>
						{subs.length > 0 && (
							<ul className="divide-y divide-kumo-line border-t border-kumo-line">
								{subs.map((feature) => {
									const on = Boolean(draft[feature.id]) && mainOn;
									return (
										<li key={feature.id} className="flex items-start justify-between gap-4 px-4 py-3 ps-8">
											<div className="min-w-0">
												<h3 className="text-sm font-medium">{feature.label}</h3>
												<p className="mt-0.5 text-sm text-kumo-subtle">{feature.description}</p>
											</div>
											<Switch className="shrink-0"
												size="sm"
												aria-label={`${feature.label}: ${on ? "on" : "off"}`}
												checked={on}
												disabled={saving || !mainOn}
												onCheckedChange={(next) => features.set(feature.id, next)}
											/>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				);
			})}

			<SaveBar
				error={result.error}
				dirty={features.dirty}
				saving={saving}
				onSave={() => void features.save()}
				onDiscard={features.discard}
			/>
		</div>
	);
}

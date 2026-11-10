/**
 * Code Blocks page: pick the site's code block theme with a live preview.
 * The label, copy button and line numbers are turned on or off on the
 * Features page; the preview shows them as they're currently set.
 */
import { Banner, Button, Select } from "@cloudflare/kumo";
import { FloppyDisk } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { apiPost, errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { SaveBar } from "./save-bar.js";
import { PartSwitches } from "./feature-switches.js";

const API = "/_emdash/api/plugins/coywolf-pack";

const post = apiPost(API);

interface ThemeOption {
	id: string;
	label: string;
	group: string;
}

type Switches = Record<string, boolean>;

export function CodeBlocksPage() {
	const [themes, setThemes] = React.useState<ThemeOption[] | null>(null);
	const [saved, setSaved] = React.useState<{ theme: string; switches: Switches } | null>(null);
	const [theme, setTheme] = React.useState("");
	const [switches, setSwitches] = React.useState<Switches>({});
	const [preview, setPreview] = React.useState<{ css: string; html: string } | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [status, setStatus] = React.useState("");
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		void (async () => {
			try {
				const [settings, features] = await Promise.all([
					apiFetch(`${API}/codeBlocks/settings`).then((r) =>
						parseApiResponse<{ theme: string; themes: ThemeOption[] }>(r, "Couldn't load settings"),
					),
					apiFetch(`${API}/features/list`).then((r) =>
						parseApiResponse<{ modules: Array<{ id: string; features: Array<{ id: string; enabled: boolean }> }> }>(
							r,
							"Couldn't load features",
						),
					),
				]);
				const mine = features.modules.find((m) => m.id === "codeBlocks")?.features ?? [];
				const state: Switches = Object.fromEntries(mine.map((f) => [f.id, f.enabled]));
				setThemes(settings.themes);
				setTheme(settings.theme);
				setSwitches(state);
				setSaved({ theme: settings.theme, switches: state });
			} catch (cause) {
				setError(errorText(cause, "Couldn't load settings"));
			}
		})();
	}, []);

	// Live preview, rendered by the same code as the site.
	React.useEffect(() => {
		if (!theme) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			post<{ css: string; html: string }>(
				"codeBlocks/preview",
				{
					theme,
					label: switches["codeBlocks.label"] ?? false,
					copy: switches["codeBlocks.copy"] ?? false,
					lineNumbers: switches["codeBlocks.lineNumbers"] ?? false,
				},
				"Couldn't load the preview",
			)
				.then((result) => !cancelled && setPreview(result))
				.catch((cause) => !cancelled && setError(errorText(cause, "Couldn't load the preview")));
		}, 120);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [theme, switches]);

	const dirty = saved !== null && theme !== saved.theme;

	async function save() {
		if (!saved) return;
		setSaving(true);
		setError(null);
		setStatus("Saving…");
		try {
			if (theme !== saved.theme) await post("codeBlocks/save", { theme }, "Couldn't save the theme");
			setSaved({ theme, switches });
			setStatus("Saved. The site picks up changes within a minute.");
		} catch (cause) {
			setStatus("");
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	const groups = themes ? [...new Set(themes.map((t) => t.group))] : [];
	const mainOn = switches.codeBlocks ?? false;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Code Blocks"
				actions={
					<>
						<Button variant="primary" icon={<FloppyDisk />} disabled={!dirty || saving} onClick={() => void save()}>
							Save
						</Button>
					</>
				}
				description={
					<>
						Syntax highlighting for code blocks on the site, done on the server, so visitors download no highlighting
						script. Only the chosen theme's styles are sent, and only on pages with code.
					</>
				}
			/>

			<PartSwitches module="codeBlocks" />

			{error && <Banner variant="error" role="alert" description={error} />}
			<p className="sr-only" role="status" aria-live="polite">
				{status}
			</p>
			{status && !saving && <p className="text-sm text-kumo-subtle">{status}</p>}

			{!themes && !error && (
				<Loading />
			)}

			{themes && (
				<div className="grid gap-6 cw-lg-cols-20-fill">
					<div className="space-y-6">
						<Select
							label="Theme"
							value={theme}
							onValueChange={(value: string | null) => value && setTheme(value)}
							items={themes.map((t) => ({ value: t.id, label: t.label }))}
						>
							{groups.map((group) => (
								<Select.Group key={group}>
									<Select.GroupLabel>{group}</Select.GroupLabel>
									{themes
										.filter((t) => t.group === group)
										.map((t) => (
											<Select.Option key={t.id} value={t.id}>
												{t.label}
											</Select.Option>
										))}
								</Select.Group>
							))}
						</Select>

					</div>

					<section aria-labelledby="cw-code-preview-title" className="min-w-0">
						<h2 id="cw-code-preview-title" className="mb-2 text-sm font-medium">
							Preview
						</h2>
						{!mainOn && (
							<p className="mb-2 text-sm text-kumo-subtle">
								Enhanced code blocks are off, so the site shows EmDash's plain code blocks. This is how they'll look when on.
							</p>
						)}
						{preview ? (
							// The markup comes from this plugin's own renderer (escaped text and hljs spans only).
							<div inert className="text-start">
								<style>{preview.css}</style>
								<div dangerouslySetInnerHTML={{ __html: preview.html }} />
							</div>
						) : (
							<Loading />
						)}
						<p className="mt-2 text-xs text-kumo-subtle">
							"Light/dark by system" themes follow your computer's appearance setting, as they will for visitors.
						</p>
					</section>
				</div>
			)}

			<SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onDiscard={() => saved && setTheme(saved.theme)} />
		</div>
	);
}

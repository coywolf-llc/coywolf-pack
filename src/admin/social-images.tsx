/**
 * Social Images page: how images are made (Browser Run: a binding or a
 * token), the template with a live preview, the collections, generating
 * images for existing entries, and the latest images.
 */
import { Badge, Banner, Button, Checkbox, Input, InputArea, Select } from "@cloudflare/kumo";
import { ArrowClockwise, ImageSquare, Play, Stop } from "@phosphor-icons/react";
import * as React from "react";

import { PACK_API, apiPost, errorText } from "./api.js";
import { CredentialGuide } from "./guides.js";
import { DocsLink, Loading, PackLink, PageHeader } from "./page.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SecretField, SettingsSection } from "./settings-ui.js";
import { useSaveResult, useToast } from "./toast.js";

const post = apiPost(`${PACK_API}/social`, { body: {} });

interface Template {
	background: string;
	text: string;
	accent: string;
	layout: "left" | "center";
	showLogo: boolean;
	showSiteName: boolean;
}

interface Doc {
	collection: string;
	id: string;
	title: string;
	key: string | null;
	status: "ready" | "pending" | "failed" | "skipped";
	note: string | null;
	updatedAt: string;
	renderedAt: string | null;
	url: string | null;
}

interface Status {
	schemaOn: boolean;
	settings: { template: Template; collections: string[]; accountId: string; defaultImages: string[] };
	renderer: { kind: "binding" | "api" } | { kind: "none"; reason: string };
	tokenSaved: boolean;
	counts: Record<Doc["status"], number>;
	backfill: { status: "idle" | "running"; queued: number; finishedAt: string | null };
	collections: Array<{ slug: string; label: string }>;
	recent: Doc[];
	defaults: Template;
}

interface Draft {
	template: Template;
	collections: string[];
	accountId: string;
	/** One URL or path per line. */
	defaultImages: string;
	token: string;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const ADMIN = "/_emdash/admin";

function useDebounced<T>(value: T, ms = 400): T {
	const [debounced, setDebounced] = React.useState(value);
	React.useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return debounced;
}

/** The template at half size, in a sandboxed frame (no scripts): the same HTML Browser Run takes a screenshot of. */
function Preview(props: { template: Template }) {
	const template = useDebounced(props.template);
	const [html, setHtml] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const valid = HEX.test(template.background) && HEX.test(template.text) && HEX.test(template.accent);
	React.useEffect(() => {
		if (!valid) return;
		let live = true;
		post<{ html: string }>("preview", { template })
			.then((r) => live && (setHtml(r.html), setError(undefined)))
			.catch((cause) => live && setError(errorText(cause, "Couldn't show the preview")));
		return () => {
			live = false;
		};
	}, [template, valid]);
	return (
		<div>
			<p className="mb-2 text-sm font-medium">Preview (half size, with a sample title)</p>
			{error && <Banner variant="error" role="alert" description={error} />}
			<div className="overflow-hidden rounded-md border border-kumo-line" style={{ width: 600, maxWidth: "100%", aspectRatio: "1200 / 630" }}>
				{html ? (
					<iframe title="Social image preview" sandbox="" srcDoc={html} style={{ width: 1200, height: 630, border: 0, transform: "scale(0.5)", transformOrigin: "0 0", pointerEvents: "none" }} />
				) : (
					<Loading className="py-12 text-center" />
				)}
			</div>
		</div>
	);
}

function ColorField(props: { label: string; value: string; onChange: (v: string) => void }) {
	const ok = HEX.test(props.value);
	return (
		<div className="flex items-end gap-2">
			<span aria-hidden="true" className="mb-1 inline-block size-8 shrink-0 rounded border border-kumo-line" style={{ background: ok ? props.value : "transparent" }} />
			<div className="min-w-0 flex-1">
				<Input label={props.label} value={props.value} placeholder="#0f172a" description={ok ? undefined : "A hex color, like #0f172a."} onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value.trim())} />
			</div>
		</div>
	);
}

export function SocialImagesPage() {
	const [status, setStatus] = React.useState<Status>();
	const [draft, setDraft] = React.useState<Draft>();
	const [saved, setSaved] = React.useState<Draft>();
	const [error, setError] = React.useState<string>();
	const [saving, setSaving] = React.useState(false);
	const [working, setWorking] = React.useState<string>();
	const [test, setTest] = React.useState<{ image?: string; error?: string; pending?: boolean }>();
	const stop = React.useRef(false);
	const result = useSaveResult();
	const toast = useToast();

	const load = React.useCallback(async () => {
		try {
			const next = await post<Status>("status", {}, "Couldn't load Social Images");
			setStatus(next);
			const d: Draft = { template: next.settings.template, collections: next.settings.collections, accountId: next.settings.accountId, defaultImages: next.settings.defaultImages.join("\n"), token: "" };
			setDraft((current) => (current && saved && isDirty(current, saved) ? current : d));
			setSaved(d);
			return next;
		} catch (cause) {
			setError(errorText(cause, "Couldn't load Social Images"));
			return undefined;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		result.clear();
		try {
			await post("settings/save", { template: draft.template, collections: draft.collections, accountId: draft.accountId, defaultImages: lines(draft.defaultImages), ...(draft.token ? { token: draft.token } : {}) }, "Couldn't save");
			const d = { ...draft, token: "" };
			setDraft(d);
			setSaved(d);
			result.saved("Social Images settings saved", "Entries get the new template when their image is made next (Generate updates the existing ones).");
			void load();
		} catch (cause) {
			result.failed(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	};

	const clearToken = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			await post("settings/save", { template: saved?.template ?? draft.template, collections: saved?.collections ?? draft.collections, accountId: saved?.accountId ?? draft.accountId, defaultImages: lines(saved?.defaultImages ?? draft.defaultImages), clearToken: true });
			toast.success("Token removed");
			void load();
		} catch (cause) {
			toast.error("Couldn't remove the token", errorText(cause, "The request failed"));
		} finally {
			setSaving(false);
		}
	};

	/** Queue the entries without an image, then make the images while the page is open (the hourly job continues otherwise). */
	const generate = async () => {
		stop.current = false;
		setWorking("Finding entries without an image…");
		setError(undefined);
		try {
			let step = await post<{ status: string; queued: number }>("backfill", { restart: true });
			while (step.status === "running" && !stop.current) step = await post<{ status: string; queued: number }>("backfill", {});
			let made = 0;
			for (let i = 0; i < 2000 && !stop.current; i++) {
				const r = await post<{ rendered: number; failed: number; stopped?: string; counts: Status["counts"] }>("render", {});
				made += r.rendered;
				setWorking(`Made ${plural(made, "image")} · ${plural(r.counts.pending, "entry", "entries")} to go`);
				setStatus((s) => (s ? { ...s, counts: r.counts } : s));
				if (r.stopped) {
					toast.error("Paused", `${r.stopped} The hourly job continues where this stopped.`);
					break;
				}
				if (!r.counts.pending || (!r.rendered && !r.failed)) break;
			}
			if (made) toast.success("Images made", plural(made, "image"));
		} catch (cause) {
			setError(errorText(cause, "Generating stopped"));
		} finally {
			setWorking(undefined);
			void load();
		}
	};

	const runTest = async () => {
		setTest({ pending: true });
		try {
			const r = await post<{ ok: boolean; image?: string; error?: string }>("test", {});
			setTest(r.ok ? { image: r.image } : { error: r.error });
		} catch (cause) {
			setTest({ error: errorText(cause, "The test failed") });
		}
	};

	const regenerate = async (doc: Doc) => {
		try {
			const r = await post<{ rendered: number; stopped?: string }>("regenerate", { collection: doc.collection, id: doc.id });
			if (r.rendered) toast.success("Image made again", doc.title);
			else toast.error("Not made yet", r.stopped ?? "It's queued for the hourly job.");
			void load();
		} catch (cause) {
			toast.error("Couldn't make it again", errorText(cause, "The request failed"));
		}
	};

	const dirty = isDirty(draft, saved);
	const valid = !draft || (HEX.test(draft.template.background) && HEX.test(draft.template.text) && HEX.test(draft.template.accent) && /^([0-9a-fA-F]{32})?$/.test(draft.accountId.trim()));
	const setTemplate = (patch: Partial<Template>) => draft && setDraft({ ...draft, template: { ...draft.template, ...patch } });
	const ready = status && status.renderer.kind !== "none";

	return (
		<div className="space-y-6">
			<PageHeader
				title="Social Images"
				actions={
					<>
						<Button variant="secondary" disabled={!ready || dirty || Boolean(test?.pending)} title={dirty ? "Save first" : undefined} onClick={() => void runTest()}>
							{test?.pending ? "Rendering…" : "Render a test image"}
						</Button>
						{working ? (
							<Button variant="secondary" icon={<Stop />} onClick={() => (stop.current = true)}>
								Stop
							</Button>
						) : (
							<Button variant="primary" icon={<Play />} disabled={!ready || dirty || !status?.schemaOn} title={dirty ? "Save first" : undefined} onClick={() => void generate()}>
								Generate for existing entries
							</Button>
						)}
					</>
				}
				description={
					<>
						An Open Graph image (1200×630: the title, your site's name and logo, in your colors) for each published entry that has no image of its own,
						made once when it's published and stored in your media bucket. Entries with an SEO image or an image field keep theirs.{" "}
						<DocsLink doc="social-images">How it works</DocsLink>
					</>
				}
			/>

			<div aria-live="polite" className="space-y-3">
				{status && !status.schemaOn && (
					<Banner
						variant="default"
						title="Turn on Schema & Social"
						description={
							<>
								The images become each page's og:image through Schema & Social. Turn it on on <PackLink page="/features">the Features page</PackLink>.
							</>
						}
					/>
				)}
				{working && <Banner variant="default" title={working} />}
				{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			</div>

			{!status && !error && <Loading />}

			{status && draft && (
				<form
					id="cw-social-form"
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						if (valid) void save();
					}}
				>
					<SettingsSection
						id="cw-social-browser"
						title="Cloudflare Browser Run"
						description={
							status.renderer.kind === "binding"
								? "Images are made through the Worker's BROWSER binding. No token needed."
								: status.renderer.kind === "api"
									? "Images are made with Browser Run's API, using the token below."
									: `Images are made by taking a screenshot of the template with Cloudflare Browser Run. ${"reason" in status.renderer ? status.renderer.reason : ""}`
						}
						actions={status.renderer.kind === "none" ? <Badge variant="warning">Not set up</Badge> : <Badge variant="success">Ready</Badge>}
					>
						{status.renderer.kind !== "binding" && (
							<>
								<div className="sm:w-72">
									<Input
										label="Cloudflare account ID"
										description="Optional when the token can see one account, or the CF_ACCOUNT_ID Worker secret is set."
										value={draft.accountId}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, accountId: e.target.value.trim() })}
									/>
								</div>
								<SecretField label="Cloudflare API token" saved={status.tokenSaved} value={draft.token} onChange={(token) => setDraft({ ...draft, token })} description="Needs Account → Browser Run → Edit." onClear={() => void clearToken()} clearing={saving} />
								<CredentialGuide id="browser-run-token" />
							</>
						)}
					</SettingsSection>

					<SettingsSection id="cw-social-template" title="Template" description="Your site's name and logo come from Settings → General.">
						<div className="grid gap-6 cw-lg-cols-fill-24">
							<Preview template={draft.template} />
							<div className="space-y-4">
								<ColorField label="Background" value={draft.template.background} onChange={(background) => setTemplate({ background })} />
								<ColorField label="Text" value={draft.template.text} onChange={(text) => setTemplate({ text })} />
								<ColorField label="Accent" value={draft.template.accent} onChange={(accent) => setTemplate({ accent })} />
								<Select
									label="Layout"
									value={draft.template.layout}
									onValueChange={(v: string | null) => setTemplate({ layout: v === "center" ? "center" : "left" })}
									items={[
										{ value: "left", label: "Title on the left, accent bar at the side" },
										{ value: "center", label: "Title centered, accent bar on top" },
									]}
								/>
								<div>
									<Checkbox label="Show the logo" checked={draft.template.showLogo} onCheckedChange={(on: boolean) => setTemplate({ showLogo: on })} />
								</div>
								<div>
									<Checkbox label="Show the site's name" checked={draft.template.showSiteName} onCheckedChange={(on: boolean) => setTemplate({ showSiteName: on })} />
								</div>
								<Button type="button" variant="ghost" size="sm" onClick={() => setTemplate(status.defaults)}>
									Reset to the default colors
								</Button>
							</div>
						</div>
						{test?.image && (
							<div>
								<p className="mb-2 text-sm font-medium">Test image from Browser Run (not stored)</p>
								<img src={test.image} alt="A test social image with a sample title" width={600} height={315} className="rounded-md border border-kumo-line" style={{ maxWidth: "100%", height: "auto" }} />
							</div>
						)}
						{test?.error && <Banner variant="error" role="alert" title="The test image couldn't be made" description={test.error} />}
					</SettingsSection>

					<SettingsSection id="cw-social-collections" title="Which entries" description="None checked makes images for every collection with public pages.">
						<div className="flex flex-wrap gap-x-6 gap-y-2">
							{status.collections.map((c) => (
								<Checkbox
									key={c.slug}
									label={c.label}
									checked={draft.collections.includes(c.slug)}
									onCheckedChange={(on: boolean) => setDraft({ ...draft, collections: on ? [...draft.collections, c.slug] : draft.collections.filter((x) => x !== c.slug) })}
								/>
							))}
						</div>
						<InputArea
							label="Theme default images (optional)"
							description="If your theme gives every page the same share image when an entry has none, enter its URL or path (one per line, like /images/share.png). Pages with it get their generated image instead. Entries with an SEO image or an image field always keep theirs."
							rows={2}
							placeholder="/theme/images/share.png"
							value={draft.defaultImages}
							onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, defaultImages: e.target.value })}
						/>
					</SettingsSection>
				</form>
			)}

			{status && (
				<SettingsSection
					id="cw-social-images"
					title="Images"
					description={`${plural(status.counts.ready, "image")} made · ${plural(status.counts.pending, "entry", "entries")} waiting · ${plural(status.counts.failed, "failure")} · ${plural(status.counts.skipped, "entry", "entries")} with an image of ${status.counts.skipped === 1 ? "its" : "their"} own`}
					actions={
						<Button variant="ghost" size="sm" icon={<ArrowClockwise />} onClick={() => void load()}>
							Refresh
						</Button>
					}
				>
					{status.recent.length === 0 ? (
						<div className="py-6 text-center text-kumo-subtle">
							<ImageSquare size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
							<p className="text-sm">No images yet. They're made when an entry is published, or select Generate for existing entries.</p>
						</div>
					) : (
						<ul className="grid gap-4 sm:grid-cols-2 cw-lg-cols-6">
							{status.recent.map((doc) => (
								<li key={`${doc.collection}:${doc.id}`} className="space-y-1 text-sm">
									{doc.url ? (
										<img src={doc.url} alt="" loading="lazy" width={300} height={158} className="w-full rounded border border-kumo-line" style={{ aspectRatio: "1200 / 630", objectFit: "cover", height: "auto" }} />
									) : (
										<div className="flex items-center justify-center rounded border border-dashed border-kumo-line text-xs text-kumo-subtle" style={{ aspectRatio: "1200 / 630" }}>
											{doc.status === "pending" ? "Waiting" : doc.status === "skipped" ? "Own image" : "No image"}
										</div>
									)}
									<a className="block truncate font-medium text-kumo-link hover:underline" href={`${ADMIN}/content/${encodeURIComponent(doc.collection)}/${encodeURIComponent(doc.id)}`} title={doc.title}>
										{doc.title || doc.id}
									</a>
									<div className="flex items-center gap-2">
										<Badge variant={doc.status === "ready" ? "success" : doc.status === "failed" ? "error" : "outline"}>{doc.status === "ready" ? "Ready" : doc.status === "failed" ? "Failed" : doc.status === "pending" ? "Waiting" : "Skipped"}</Badge>
										{doc.status !== "skipped" && ready && (
											<Button variant="ghost" size="sm" onClick={() => void regenerate(doc)}>
												Make again
											</Button>
										)}
									</div>
									{doc.note && doc.status !== "ready" && <p className="text-xs text-kumo-subtle">{doc.note}</p>}
								</li>
							))}
						</ul>
					)}
				</SettingsSection>
			)}

			{draft && <SaveBar dirty={dirty} saving={saving} canSave={valid} form="cw-social-form" error={result.error} onDiscard={() => saved && setDraft(saved)} />}
		</div>
	);
}

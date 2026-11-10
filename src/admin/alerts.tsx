/**
 * Alerts & Digest page: whether email is set up (with the steps when it
 * isn't), who gets alerts, which alerts, the bill threshold, the digest's
 * preview, and the last emails sent.
 */
import { Badge, Banner, Button, Checkbox, Dialog, Input, InputArea } from "@cloudflare/kumo";
import { BellRinging, EnvelopeSimple, Eye } from "@phosphor-icons/react";
import * as React from "react";

import { PACK_API, apiPost, errorText } from "./api.js";
import { PartSwitches } from "./feature-switches.js";
import { DocsLink, Loading, PackLink, PageHeader } from "./page.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SetupCard } from "./settings-ui.js";
import { useSaveResult, useToast } from "./toast.js";

const post = apiPost(`${PACK_API}/alerts`, { body: {} });

type AlertType = "backupFailed" | "brokenLinks" | "bill" | "update" | "auditWorsened";

interface Settings {
	recipients: "admins" | "list";
	emails: string[];
	alerts: Record<AlertType, boolean>;
	billThreshold: number;
}

interface Status {
	settings: Settings;
	emailConfigured: boolean;
	usersReadable: boolean;
	recipients: string[];
	digest: boolean;
	alerts: Array<{ id: AlertType; label: string; description: string; feature: string; available: boolean }>;
	lastCheckAt: string | null;
	lastDigestAt: string | null;
	log: Array<{ at: string; kind: "alert" | "digest" | "test"; subject: string; sent: number; failed: number; error?: string }>;
}

interface Draft {
	recipients: "admins" | "list";
	emails: string;
	alerts: Record<AlertType, boolean>;
	billThreshold: string;
}

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const toDraft = (s: Settings): Draft => ({ recipients: s.recipients, emails: s.emails.join("\n"), alerts: { ...s.alerts }, billThreshold: s.billThreshold ? String(s.billThreshold) : "" });

/** Which module each alert reads, for "turn it on first". */
const FEATURE_NAMES: Record<string, { label: string; page: string }> = {
	backups: { label: "Backups", page: "/backups" },
	"links.check": { label: "Scheduled link checking", page: "/links" },
	updates: { label: "Update check", page: "/features" },
	audit: { label: "Content Audit", page: "/features" },
};

const C = (props: { children: React.ReactNode }) => <code className="rounded bg-kumo-tint px-1 py-0.5 text-xs">{props.children}</code>;

function EmailSetup() {
	return (
		<SetupCard
			title="Set up email first"
			description="Alerts go out through EmDash's email provider, and this site doesn't have one selected yet. On Cloudflare, EmDash's Cloudflare Email plugin sends through the Worker's Send Email binding:"
		>
			<ol className="space-y-2 text-sm" style={{ listStyle: "decimal", paddingInlineStart: "1.25rem" }}>
				<li>
					In the Cloudflare dashboard, onboard your domain (or a subdomain such as <C>mail.example.com</C>) to <strong>Email Sending</strong>, so Cloudflare adds its sending records.
				</li>
				<li>
					In the site's <C>wrangler.jsonc</C>, add the binding: <C>{'"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["noreply@example.com"] }]'}</C>.
				</li>
				<li>
					In <C>astro.config.mjs</C>, import <C>{'cloudflareEmail'}</C> from <C>@emdash-cms/cloudflare/plugins</C> and add <C>{'cloudflareEmail({ from: { email: "noreply@example.com", name: "Your site" } })'}</C> to EmDash's <C>plugins</C>.
				</li>
				<li>Deploy. Then, in this admin, activate the Cloudflare Email plugin under Plugins, and select it under Settings → Email.</li>
				<li>Use Settings → Email → Send test email to check it, then come back here and select Send test email.</li>
			</ol>
			<p className="text-sm text-kumo-subtle">
				Any other EmDash email provider plugin (SMTP, for example) works the same way. <DocsLink doc="alerts#set-up-email">More in the docs</DocsLink>.
			</p>
		</SetupCard>
	);
}

function DigestPreview(props: { open: boolean; onClose: () => void }) {
	const [preview, setPreview] = React.useState<{ sections: number; email?: { subject: string; text: string } }>();
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		if (!props.open) return;
		setPreview(undefined);
		setError(undefined);
		post<{ sections: number; email?: { subject: string; text: string } }>("digest/preview", {})
			.then(setPreview)
			.catch((cause) => setError(errorText(cause, "Couldn't build the digest")));
	}, [props.open]);
	return (
		<Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">This week's digest</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">What the digest would say if it went out now. Nothing is sent.</Dialog.Description>
				<div className="mt-4">
					{error ? (
						<Banner variant="error" role="alert" description={error} />
					) : !preview ? (
						<Loading className="py-6 text-center" />
					) : !preview.email ? (
						<p className="text-sm text-kumo-subtle">Nothing to report yet: turn on Backups, Link Manager, Content Audit, the update check or the Cloudflare usage card, and the digest sums them up.</p>
					) : (
						<>
							<p className="text-sm font-medium">{preview.email.subject}</p>
							<pre className="mt-2 max-h-96 cw-overflow-auto cw-pre-wrap rounded-md border border-kumo-line bg-kumo-tint p-3 text-xs leading-5">{preview.email.text}</pre>
						</>
					)}
				</div>
				<div className="mt-6 flex justify-end">
					<Button variant="secondary" onClick={props.onClose}>
						Close
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

export function AlertsPage() {
	const [status, setStatus] = React.useState<Status>();
	const [draft, setDraft] = React.useState<Draft>();
	const [saved, setSaved] = React.useState<Draft>();
	const [error, setError] = React.useState<string>();
	const [saving, setSaving] = React.useState(false);
	const [busy, setBusy] = React.useState<string>();
	const [previewOpen, setPreviewOpen] = React.useState(false);
	const result = useSaveResult();
	const toast = useToast();

	const load = React.useCallback(async () => {
		try {
			const next = await post<Status>("status", {}, "Couldn't load Alerts");
			setStatus(next);
			setDraft(toDraft(next.settings));
			setSaved(toDraft(next.settings));
		} catch (cause) {
			setError(errorText(cause, "Couldn't load Alerts"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		result.clear();
		try {
			const threshold = draft.billThreshold.trim() ? Number(draft.billThreshold) : 0;
			if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Enter the bill threshold in dollars, like 10 or 25.50, or leave it empty.");
			const { settings } = await post<{ settings: Settings }>("settings/save", { recipients: draft.recipients, emails: draft.emails, alerts: draft.alerts, billThreshold: threshold }, "Couldn't save");
			setDraft(toDraft(settings));
			setSaved(toDraft(settings));
			result.saved("Alert settings saved");
			void load();
		} catch (cause) {
			result.failed(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	};

	const act = async (path: "test" | "check", label: string) => {
		setBusy(label);
		try {
			if (path === "test") {
				const r = await post<{ to: number; sent: number; failed: number; error?: string }>("test", {});
				if (r.sent) toast.success("Test email sent", `To ${r.sent === 1 ? "1 address" : `${r.sent} addresses`}. Check the inbox (and the spam folder).`);
				else toast.error("The test email didn't go out", r.error ?? "No recipients.");
			} else {
				const r = await post<{ issues: number; sent: string[]; result: { sent: number; error?: string } | null }>("check", {});
				if (r.sent.length) toast.success("Alert sent", r.sent.join(", "));
				else if (r.result?.error) toast.error("Nothing could be sent", r.result.error);
				else toast.success(r.issues ? "Nothing new to send" : "All clear", r.issues ? "Everything found was already sent today." : "No alerts right now.");
			}
			void load();
		} catch (cause) {
			toast.error("Something went wrong", errorText(cause, "The request failed"));
		} finally {
			setBusy(undefined);
		}
	};

	const dirty = isDirty(draft, saved);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Alerts & Digest"
				actions={
					<>
						<Button variant="secondary" icon={<Eye />} disabled={!status} onClick={() => setPreviewOpen(true)}>
							Preview digest
						</Button>
						<Button variant="secondary" icon={<BellRinging />} disabled={!status?.emailConfigured || Boolean(busy)} onClick={() => void act("check", "check")}>
							{busy === "check" ? "Checking…" : "Check now"}
						</Button>
						<Button variant="primary" icon={<EnvelopeSimple />} disabled={!status?.emailConfigured || Boolean(busy) || dirty} title={dirty ? "Save first" : undefined} onClick={() => void act("test", "test")}>
							{busy === "test" ? "Sending…" : "Send test email"}
						</Button>
					</>
				}
				description={
					<>
						An email when something needs a look, checked every hour: at most one per problem a day, and nothing when all is well. Plus, if you turn
						it on below, a weekly digest. <DocsLink doc="alerts">How alerts work</DocsLink>
					</>
				}
			/>

			{error && <Banner variant="error" role="alert" description={error} />}
			{!status && !error && <Loading />}
			{status && !status.emailConfigured && <EmailSetup />}
			{status && <PartSwitches module="alerts" />}

			{status && draft && (
				<form
					id="cw-alerts-form"
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<section className="rounded-lg border border-kumo-line" aria-labelledby="cw-alerts-who">
						<div className="border-b border-kumo-line p-4">
							<h2 id="cw-alerts-who" className="text-base font-semibold">
								Who gets them
							</h2>
							<p className="mt-1 text-sm text-kumo-subtle">Each address gets its own email, so nobody sees the others. At most 10.</p>
						</div>
						<div className="space-y-3 p-4">
							<label className="flex items-start gap-2 text-sm">
								<input type="radio" name="cw-alerts-recipients" className="mt-1" checked={draft.recipients === "admins"} onChange={() => setDraft({ ...draft, recipients: "admins" })} />
								<span>
									<span className="font-medium">The site's admins</span>
									<span className="block text-kumo-subtle">
										{status.recipients.length && status.settings.recipients === "admins" ? status.recipients.join(", ") : status.usersReadable ? "Everyone with the Admin role." : "Everyone with the Admin role (the list can't be read here)."}
									</span>
								</span>
							</label>
							<label className="flex items-start gap-2 text-sm">
								<input type="radio" name="cw-alerts-recipients" className="mt-1" checked={draft.recipients === "list"} onChange={() => setDraft({ ...draft, recipients: "list" })} />
								<span className="font-medium">These addresses</span>
							</label>
							{draft.recipients === "list" && (
								<InputArea
									label="Email addresses (one per line, or separated by commas)"
									rows={3}
									placeholder="you@example.com"
									value={draft.emails}
									onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, emails: e.target.value })}
								/>
							)}
						</div>
					</section>

					<section className="rounded-lg border border-kumo-line" aria-labelledby="cw-alerts-which">
						<div className="border-b border-kumo-line p-4">
							<h2 id="cw-alerts-which" className="text-base font-semibold">
								Alerts
							</h2>
							<p className="mt-1 text-sm text-kumo-subtle">Each reads what its module already keeps, so it works only while that module is on.</p>
						</div>
						<ul className="divide-y divide-kumo-line">
							{status.alerts.map((a) => {
								const needs = a.feature ? FEATURE_NAMES[a.feature] : undefined;
								return (
									<li key={a.id} className="space-y-2 px-4 py-3">
										<Checkbox label={a.label} checked={draft.alerts[a.id]} onCheckedChange={(on: boolean) => setDraft({ ...draft, alerts: { ...draft.alerts, [a.id]: on } })} />
										<p className="cw-ps-6 text-sm text-kumo-subtle">
											{a.description}
											{!a.available && needs && (
												<>
													{" "}
													<Badge variant="outline">Off</Badge> Turn on <PackLink page={needs.page}>{needs.label}</PackLink> first.
												</>
											)}
										</p>
										{a.id === "bill" && draft.alerts.bill && (
											<div className="cw-ps-6 sm:w-64">
												<Input
													type="number"
													min={0}
													step="0.01"
													label="Threshold (US dollars)"
													description="Empty turns this alert off. Needs the Cloudflare usage token (Performance page)."
													placeholder="25"
													value={draft.billThreshold}
													onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, billThreshold: e.target.value })}
												/>
											</div>
										)}
									</li>
								);
							})}
						</ul>
					</section>
				</form>
			)}

			{status && (
				<section className="rounded-lg border border-kumo-line" aria-labelledby="cw-alerts-log">
					<div className="border-b border-kumo-line p-4">
						<h2 id="cw-alerts-log" className="text-base font-semibold">
							Recent emails
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							Last check: {status.lastCheckAt ? dateTime.format(new Date(status.lastCheckAt)) : "not yet"}
							{status.digest ? ` · Last digest: ${status.lastDigestAt ? dateTime.format(new Date(status.lastDigestAt)) : "not yet"}` : ""}
						</p>
					</div>
					{status.log.length === 0 ? (
						<p className="px-4 py-6 text-center text-sm text-kumo-subtle">No emails yet.</p>
					) : (
						<ul className="divide-y divide-kumo-line">
							{status.log.map((entry) => (
								<li key={`${entry.at}-${entry.kind}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
									<span className="text-kumo-subtle">{dateTime.format(new Date(entry.at))}</span>
									<Badge variant={entry.failed && !entry.sent ? "error" : "secondary"}>{entry.kind === "alert" ? "Alert" : entry.kind === "digest" ? "Digest" : "Test"}</Badge>
									<span className="min-w-0 flex-1 truncate">{entry.subject}</span>
									<span className="text-kumo-subtle">{entry.sent ? `Sent to ${entry.sent}` : (entry.error ?? "Not sent")}</span>
								</li>
							))}
						</ul>
					)}
				</section>
			)}

			<DigestPreview open={previewOpen} onClose={() => setPreviewOpen(false)} />
			{draft && <SaveBar dirty={dirty} saving={saving} form="cw-alerts-form" error={result.error} onDiscard={() => saved && setDraft(saved)} />}
		</div>
	);
}

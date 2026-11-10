/**
 * The Backups page's "Retention on Cloudflare" card: sets the backup bucket's
 * R2 lifecycle rule to the pack's retention days (so Cloudflare deletes old
 * backups, and the site stops doing it), with an optional bucket lock. Uses a
 * Cloudflare API token entered here (or a Worker secret), never in chat.
 */
import { Badge, Banner, Button, Checkbox, Input } from "@cloudflare/kumo";
import { ArrowsClockwise, LockSimple, MagnifyingGlass } from "@phosphor-icons/react";
import * as React from "react";

import { apiGet, apiPost, errorText } from "./api.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { CredentialGuide } from "./guides.js";
import { DocsLink } from "./page.js";
import { SecretField, SettingsSection } from "./settings-ui.js";
import { AGING_PREFIXES, backupsStoppedWarning, days, lifecycleSummary } from "./backups-retention-core.js";
import { useToast } from "./toast.js";

const API = "/_emdash/api/plugins/coywolf-pack/backups";
const post = apiPost(API);
const get = apiGet(API);

/** What the server found on the bucket (src/backups/retention.ts RetentionStatus). */
export interface RetentionStatus {
	lifecycle: "on" | "different" | "partial" | "off";
	byPrefix: Record<string, number | null>;
	coveredDays: number | null;
	ours: boolean;
	otherRules: number;
	mirrorDeleted: boolean;
	lockDays: number | null;
	mirrorLocked: boolean;
	d1Locked: boolean;
	dateDeletes?: boolean;
	otherLocks: number;
}

export interface RetentionState {
	checkedAt: string;
	bucket: string;
	retentionDays: number;
	status: RetentionStatus;
}

interface RetentionInfo {
	accountId: string;
	bucket: string;
	suggestedBucket: string;
	tokenSaved: boolean;
	envToken: boolean;
	envTokenName: string;
	envAccountId: boolean;
	retentionDays: number;
	state: RetentionState | null;
	/** When the newest backup was made (ISO), or null. */
	newestBackup?: string | null;
}

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function RetentionCard(props: { retentionDays: number; onChanged?: () => void }) {
	const toast = useToast();
	const [info, setInfo] = React.useState<RetentionInfo>();
	const [loadError, setLoadError] = React.useState<string>();
	const [draft, setDraft] = React.useState({ accountId: "", bucket: "", token: "", saveToken: false });
	const [lock, setLock] = React.useState(false);
	const [open, setOpen] = React.useState(false);
	const [pending, setPending] = React.useState<"check" | "apply" | "remove">();
	const [error, setError] = React.useState<string>();
	const [confirm, setConfirm] = React.useState<"lock" | "remove">();
	const [typed, setTyped] = React.useState("");

	const load = React.useCallback(async () => {
		try {
			const next = await get<RetentionInfo>("cloudflare", "Couldn't read the retention settings");
			setInfo(next);
			setDraft((d) => ({ ...d, accountId: d.accountId || next.accountId, bucket: d.bucket || next.bucket }));
			setLock(next.state?.status.lockDays != null);
			setLoadError(undefined);
		} catch (cause) {
			setLoadError(errorText(cause, "Couldn't read the retention settings"));
		}
	}, []);
	React.useEffect(() => void load(), [load]);
	// The retention days changed on this page: the summary compares against the saved number.
	React.useEffect(() => void load(), [props.retentionDays, load]);

	const credentials = () => ({
		...(draft.accountId.trim() ? { accountId: draft.accountId.trim() } : {}),
		...(draft.bucket.trim() ? { bucket: draft.bucket.trim() } : {}),
		...(draft.token.trim() ? { token: draft.token.trim() } : {}),
	});

	const run = async (kind: "check" | "apply" | "remove", body: Record<string, unknown> = {}) => {
		setPending(kind);
		setError(undefined);
		try {
			const state = await post<RetentionState>(kind === "check" ? "cloudflare/check" : kind === "apply" ? "cloudflare/apply" : "cloudflare/remove", { ...credentials(), ...body });
			setInfo((current) => (current ? { ...current, state, bucket: state.bucket, tokenSaved: current.tokenSaved || Boolean(body.saveToken && draft.token.trim()) } : current));
			setDraft((d) => ({ ...d, token: "" }));
			setConfirm(undefined);
			setTyped("");
			if (kind === "apply") toast.success("Retention set on the backup bucket", lifecycleSummary(state, props.retentionDays).text);
			if (kind === "remove") toast.success("The pack's rules were removed", "The site deletes old backups itself again, from tomorrow.");
			if (kind !== "check") setOpen(false);
			props.onChanged?.();
			return true;
		} catch (cause) {
			setError(errorText(cause, "Cloudflare didn't accept the request"));
			return false;
		} finally {
			setPending(undefined);
		}
	};

	if (loadError) return <Banner variant="error" role="alert" title="Retention on Cloudflare" description={loadError} />;
	if (!info) return null;

	const state = info.state;
	const status = state?.status;
	const summary = lifecycleSummary(state, props.retentionDays);
	const inSync = Boolean(status && AGING_PREFIXES.every((p) => status.byPrefix[p] === props.retentionDays));
	const lockInSync = (status?.lockDays ?? null) === (lock ? props.retentionDays : null);
	const showForm = open || !state;
	const stoppedWarning = backupsStoppedWarning(info.newestBackup, props.retentionDays, Boolean(state && AGING_PREFIXES.every((p) => state.status.byPrefix[p] != null)));
	const hasToken = Boolean(draft.token.trim() || info.tokenSaved || info.envToken);
	const ready = Boolean((draft.accountId.trim() || info.envAccountId) && (draft.bucket.trim() || info.bucket) && hasToken);
	const busy = pending !== undefined;
	const applyLabel = status?.ours ? (inSync ? "Apply again" : `Update the rule to ${days(props.retentionDays)}`) : "Set the retention rule";

	const apply = () => {
		if (lock && status?.lockDays !== props.retentionDays) {
			setConfirm("lock");
			return;
		}
		// The lock is already at these days (confirmed when it was set), or it's being removed.
		void run("apply", { lock, saveToken: draft.saveToken, ...(lock ? { confirm: "LOCK" } : {}) });
	};

	return (
		<SettingsSection
			id="backups-retention"
			title="Retention on Cloudflare (optional)"
			description={
				<>
					Let Cloudflare delete old backups instead of the site: a lifecycle rule on the backup bucket deletes database backups and
					the copies of replaced files {days(props.retentionDays)} after they're made (the Keep backups for setting above). Once it's
					there, the site stops deleting them itself, and backups made by an external job (such as a GitHub Action) age out too.
					The mirrors of your live media and uploads are never touched. See <DocsLink doc="backups#retention-on-cloudflare">the Backups docs</DocsLink>.
				</>
			}
			actions={
				state && !open ? (
					<Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(true)}>
						Change
					</Button>
				) : undefined
			}
		>
			<div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
				<Badge variant={summary.variant}>Lifecycle rule: {summary.badge}</Badge>
				<Badge variant={status?.lockDays != null ? "primary" : "outline"}>
					<span className="inline-flex items-center gap-1">
						<LockSimple aria-hidden="true" size={12} />
						{status?.lockDays != null ? `Locked for ${days(status.lockDays)}` : "No lock"}
					</span>
				</Badge>
				{state && <span className="text-kumo-subtle">Bucket {state.bucket}, checked {dateFormat.format(new Date(state.checkedAt))}</span>}
			</div>
			<p className="text-sm">{summary.text}</p>

			{status?.mirrorDeleted && (
				<Banner
					variant="error"
					role="alert"
					title="A lifecycle rule on this bucket deletes the mirrors of your live files"
					description="Another rule covers media/current/ or uploads/current/ (or the whole bucket), so Cloudflare deletes the backup copies of files that are still in use. Remove or narrow that rule in the Cloudflare dashboard (R2 → the bucket → Settings → Object lifecycle rules)."
				/>
			)}
			{status?.dateDeletes && (
				<Banner
					variant="alert"
					title="A lifecycle rule deletes backups on a fixed date"
					description="Another rule on this bucket deletes database backups or copies of replaced files on a set date, whatever Keep backups for says. Check it in the Cloudflare dashboard (R2 → the bucket → Settings → Object lifecycle rules)."
				/>
			)}
			{stoppedWarning && <Banner variant="error" role="alert" title="Backups may have stopped" description={stoppedWarning} />}
			{status?.mirrorLocked && (
				<Banner
					variant="alert"
					title="A bucket lock covers the mirrors"
					description="Another lock rule covers media/current/ or uploads/current/ (or the whole bucket), so the backup can't update or remove files in the mirror. Narrow it to d1/, media/changed/ and uploads/changed/ (R2 → the bucket → Settings → Bucket lock rules)."
				/>
			)}
			{status && status.otherRules > 0 && (
				<p className="text-xs text-kumo-subtle">
					The bucket has {status.otherRules} other lifecycle {status.otherRules === 1 ? "rule" : "rules"} (such as Cloudflare's default that aborts unfinished uploads after 7 days). They're kept as they are.
				</p>
			)}

			{showForm && (
				<div className="space-y-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Cloudflare account ID"
							placeholder={info.envAccountId ? "From the site's settings" : "32 letters and numbers"}
							value={draft.accountId}
							disabled={busy}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, accountId: e.target.value }))}
						/>
						<Input
							label="Backup bucket name"
							description="The bucket_name of the BACKUPS binding in wrangler.jsonc. The check makes sure it's this site's."
							placeholder={info.suggestedBucket}
							value={draft.bucket}
							disabled={busy}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, bucket: e.target.value }))}
						/>
					</div>
					<SecretField
						label="Cloudflare API token"
						saved={info.tokenSaved}
						value={draft.token}
						disabled={busy}
						description={
							info.envToken
								? `Leave empty to use the ${info.envTokenName} Worker secret (it needs Workers R2 Storage → Edit).`
								: "Needs Account → Workers R2 Storage → Edit. Used only with api.cloudflare.com."
						}
						onChange={(token) => setDraft((d) => ({ ...d, token }))}
					/>
					{draft.token.trim() && (
						<Checkbox
							label="Remember the token (stored encrypted), so the site can look at the rule each day"
							checked={draft.saveToken}
							onCheckedChange={(checked: boolean) => setDraft((d) => ({ ...d, saveToken: checked }))}
						/>
					)}
					<CredentialGuide id="backups-token" />
					<CredentialGuide id="backups-retention" />
				</div>
			)}

			<div className="space-y-2 rounded-md border border-kumo-line p-3">
				<Checkbox
					label={`Also lock backups for ${days(props.retentionDays)} (optional)`}
					checked={lock}
					disabled={busy}
					onCheckedChange={(checked: boolean) => setLock(checked)}
				/>
				<p className="text-sm text-kumo-subtle">
					A bucket lock stops anyone from deleting or overwriting a backup until it's {days(props.retentionDays)} old: not the
					site, not a mistaken script, not someone using the site's R2 access. The catch: <strong className="font-medium">you
					can't delete those backups early either</strong> (to save space, or to remove data you were asked to delete), and you
					can't empty or delete the bucket, until the lock is removed here or in the Cloudflare dashboard. Removing it needs a
					token like this one, so keep such tokens safe.
				</p>
			</div>

			{error && <Banner variant="error" role="alert" description={error} />}

			<p className="text-sm text-kumo-subtle">
				Cloudflare deletes backups by age, whether or not new ones are being made: if backups stop working, after{" "}
				{days(props.retentionDays)} none is left (the site's own pruning skips a day when the backup fails; the rule doesn't). The
				dashboard widget warns when backups stop, and so does this card once the newest is older than half the retention days. A
				longer Keep backups for gives you more time to notice. The lock doesn't help with this: it ends at the same age.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button type="button" variant="secondary" icon={<MagnifyingGlass />} disabled={busy || !ready} onClick={() => void run("check", { saveToken: draft.saveToken })}>
					{pending === "check" ? "Checking…" : "Check"}
				</Button>
				<Button type="button" variant="primary" icon={<ArrowsClockwise />} disabled={busy || !ready || (inSync && lockInSync && !open)} onClick={apply}>
					{pending === "apply" ? "Applying…" : lock && !lockInSync ? `${applyLabel} and lock` : applyLabel}
				</Button>
				{(status?.ours || status?.lockDays != null) && (
					<Button type="button" variant="ghost" disabled={busy || !ready} onClick={() => setConfirm("remove")}>
						Remove the pack's rules
					</Button>
				)}
			</div>
			{!ready && <p className="text-xs text-kumo-subtle">Enter the account ID, the backup bucket name and a token (or set the {info.envTokenName} Worker secret) first.</p>}

			<ConfirmDialog
				open={confirm === "lock"}
				onClose={() => {
					setConfirm(undefined);
					setTyped("");
				}}
				title={`Lock backups for ${days(props.retentionDays)}?`}
				description="Each database backup and each copy of a replaced file is then kept, and can't be deleted or overwritten, until it's that old. That includes deleting it yourself. The lock can be removed later with a Cloudflare API token."
				confirmLabel="Set the rule and lock"
				pendingLabel="Applying…"
				variant="primary"
				confirmDisabled={typed !== "LOCK"}
				isPending={pending === "apply"}
				error={confirm === "lock" ? error : null}
				onConfirm={() => void run("apply", { lock: true, confirm: "LOCK", saveToken: draft.saveToken })}
			>
				<Input label="Type LOCK to confirm" value={typed} autoComplete="off" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)} />
			</ConfirmDialog>

			<ConfirmDialog
				open={confirm === "remove"}
				onClose={() => setConfirm(undefined)}
				title="Remove the pack's rules from the backup bucket?"
				description="The lifecycle rule and the lock the pack set are removed; the bucket's other rules stay. From tomorrow the site deletes backups older than the retention days itself again."
				confirmLabel="Remove"
				pendingLabel="Removing…"
				isPending={pending === "remove"}
				error={confirm === "remove" ? error : null}
				onConfirm={() => void run("remove")}
			/>
		</SettingsSection>
	);
}

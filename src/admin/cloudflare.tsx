/**
 * Cloudflare Checkup page (Coywolf Pack → Cloudflare Checkup): the site's
 * zone settings, read from Cloudflare when the page opens, each with what it
 * does and what to do, grouped (speed, HTTPS, features that rewrite pages,
 * bots). The clear-cut ones have a one-click fix that uses a separate setup
 * token, after a confirmation that says exactly what changes and which other
 * hostnames share the zone. HSTS is only ever explained, never set.
 */
import { Badge, Banner, Button } from "@cloudflare/kumo";
import { ArrowClockwise, ArrowSquareOut, CheckCircle, Info, Question, Warning, Wrench } from "@phosphor-icons/react";
import * as React from "react";

import { PACK_API, apiGet, apiPost, errorText } from "./api.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { CredentialGuide } from "./guides.js";
import { DocsLink, Loading, PageHeader } from "./page.js";
import { SecretField, SharedTokenNote } from "./settings-ui.js";
import { useToast } from "./toast.js";

type RowStatus = "good" | "warn" | "info" | "unknown";
type FixId = "speed-brain-off" | "always-use-https-on" | "min-tls-1.2";

interface Row {
	id: string;
	group: "speed" | "https" | "html" | "bots";
	label: string;
	value: string | null;
	status: RowStatus;
	explanation: string;
	recommendation: string;
	dashboardUrl: string;
	zoneWide: boolean;
	fix?: FixId;
	caution?: string;
	docs?: string;
	guide?: "tracking-params";
}

interface Checkup {
	host: string;
	zone: { id: string; name: string; accountId: string | null } | null;
	problem?: { kind: "no-token" | "bad-token" | "no-zone" | "no-access" | "error"; message: string };
	rows: Row[];
	otherHosts: string[] | null;
	otherHostsMore?: boolean;
	otherHostsProblem?: string;
	checkedAt: string;
	setupToken: { saved: boolean; unreadable: boolean };
	/** The fixes use the Cloudflare API token (saved on Settings, or `sharedTokenEnv`: the Worker secret): no setup token needed. */
	sharedToken?: boolean;
	sharedTokenEnv?: boolean;
	fixes: Record<FixId, { title: string; button: string; setting: string; target: string; targetLabel: string; effect: string }>;
}

interface FixResult {
	changed: boolean;
	message: string;
}

const API = `${PACK_API}/cloudflare`;
const get = apiGet(API, { fallback: "Couldn't read the zone" });
const post = apiPost(API, { fallback: "Something went wrong" });

const GROUPS: Array<{ id: Row["group"]; title: string; description: string }> = [
	{ id: "speed", title: "Speed", description: "Settings that make pages arrive sooner." },
	{ id: "https", title: "HTTPS", description: "How visitors connect, and how securely." },
	{ id: "html", title: "Features that rewrite pages", description: "Cloudflare features that change a page's HTML on its way to the visitor." },
	{ id: "bots", title: "Bots", description: "Cloudflare's bot settings, which can contradict what your robots.txt says." },
];

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function StatusIcon({ status }: { status: RowStatus }) {
	const style = (color: string) => ({ color, flexShrink: 0, marginTop: 1 });
	const common = { size: 20, weight: "fill" as const, role: "img" };
	if (status === "good") return <CheckCircle {...common} style={style("var(--color-kumo-success, #16a34a)")} aria-label="Good" />;
	if (status === "warn") return <Warning {...common} style={style("var(--color-kumo-warning, #d97706)")} aria-label="Needs attention" />;
	if (status === "info") return <Info {...common} style={style("var(--color-kumo-subtle, #6b7280)")} aria-label="Your choice" />;
	return <Question {...common} style={style("var(--color-kumo-subtle, #6b7280)")} aria-label="Couldn't read" />;
}

function RowItem(props: { row: Row; onFix: (fix: FixId) => void; busy: boolean; fixes: Checkup["fixes"] }) {
	const { row } = props;
	return (
		<li className="flex items-start gap-3 px-4 py-4">
			<StatusIcon status={row.status} />
			<div className="min-w-0 flex-1 space-y-1.5">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="text-sm font-semibold">{row.label}</h3>
					{row.value && <Badge variant={row.status === "warn" ? "primary" : "secondary"}>{row.value}</Badge>}
				</div>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">{row.explanation}</p>
				<p className="text-sm leading-5 text-pretty">
					<span className="font-medium">{row.status === "warn" ? "Recommended: " : ""}</span>
					{row.recommendation}
				</p>
				{row.caution && (
					<p className="text-sm leading-5 text-pretty text-kumo-danger">
						<span className="font-medium">Before you turn it on: </span>
						{row.caution}
					</p>
				)}
				{row.guide && (
					<div className="pt-1 sm:max-w-md">
						<CredentialGuide id="tracking-params" />
					</div>
				)}
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-sm">
					{row.fix && (
						<Button size="sm" variant="secondary" icon={<Wrench />} disabled={props.busy} onClick={() => props.onFix(row.fix as FixId)}>
							{props.fixes[row.fix]?.button ?? "Fix"}
						</Button>
					)}
					{row.docs ? (
						<DocsLink doc={row.docs}>How to set it up</DocsLink>
					) : (
						<a className="inline-flex items-center gap-1 text-kumo-link underline" href={row.dashboardUrl} target="_blank" rel="noreferrer">
							Open in Cloudflare
							<ArrowSquareOut aria-hidden="true" className="shrink-0" />
						</a>
					)}
					{row.zoneWide && <span className="text-kumo-subtle">Applies to the whole zone</span>}
				</div>
			</div>
		</li>
	);
}

/** Who else a zone-wide change reaches, in words. */
function zoneReach(data: Checkup): string {
	const zone = data.zone?.name ?? "the zone";
	if (data.otherHosts === null) return `Zone settings apply to every hostname in ${zone}, not just ${data.host}.`;
	if (!data.otherHosts.length && !data.otherHostsMore) return `${data.host} is the only proxied hostname in ${zone}, so zone settings affect only this site.`;
	const list = data.otherHosts.slice(0, 12).join(", ") || "others";
	const more = data.otherHostsMore ? " and more (the zone has over 500 proxied DNS records)" : data.otherHosts.length > 12 ? ` and ${data.otherHosts.length - 12} more` : "";
	return `Zone settings apply to every hostname in ${zone}: besides ${data.host}, that's ${list}${more}. A change here changes them too.`;
}

export function CloudflareCheckupPage() {
	const toast = useToast();
	const [data, setData] = React.useState<Checkup | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [loading, setLoading] = React.useState(true);
	const [token, setToken] = React.useState("");
	const [tokenBusy, setTokenBusy] = React.useState<"save" | "clear" | null>(null);
	const [asking, setAsking] = React.useState<FixId | null>(null);
	const [fixing, setFixing] = React.useState(false);
	const [fixError, setFixError] = React.useState<string | null>(null);
	const lastAsked = React.useRef<{ fix: FixId; value: string | null } | null>(null);

	const load = React.useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setData(await get<Checkup>("checkup"));
		} catch (cause) {
			setError(errorText(cause, "Couldn't read the zone"));
		} finally {
			setLoading(false);
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const saveToken = async (clear: boolean) => {
		setTokenBusy(clear ? "clear" : "save");
		try {
			const result = await post<{ saved: boolean }>("token/save", clear ? { clear: true } : { token: token.trim() });
			setData((d) => (d ? { ...d, setupToken: { saved: result.saved, unreadable: false } } : d));
			setToken("");
			toast.success(clear ? "Setup token removed" : "Setup token saved", clear ? undefined : "Stored encrypted. It's used only for the fixes on this page.");
		} catch (cause) {
			toast.error(clear ? "Couldn't remove the token" : "Couldn't save the token", errorText(cause, "Something went wrong"));
		} finally {
			setTokenBusy(null);
		}
	};

	const applyFix = async () => {
		if (!asking) return;
		setFixing(true);
		setFixError(null);
		try {
			const result = await post<FixResult>("fix", { fix: asking, ...(token.trim() ? { token: token.trim() } : {}) });
			setAsking(null);
			toast.success(result.changed ? "Changed in Cloudflare" : "Already set", result.message);
			await load();
		} catch (cause) {
			setFixError(errorText(cause, "Cloudflare refused the change"));
		} finally {
			setFixing(false);
		}
	};

	const header = (
		<PageHeader
			title="Cloudflare Checkup"
			description={
				<>
					The settings of your site's Cloudflare zone that matter for an EmDash site served by a Worker, read from Cloudflare each time you open this page. Each
					row says what the setting does and what to do. A few clear-cut ones have a one-click fix; the rest link to the switch in Cloudflare. See{" "}
					<DocsLink doc="cloudflare-checkup">the Cloudflare Checkup docs</DocsLink>.
				</>
			}
			actions={
				<Button variant="secondary" icon={<ArrowClockwise />} disabled={loading} onClick={() => void load()}>
					{loading ? "Checking…" : "Check again"}
				</Button>
			}
		/>
	);

	if (!data) {
		return (
			<div className="space-y-6">
				{header}
				{error ? <Banner variant="error" role="alert" description={error} /> : <Loading label="Reading the zone's settings…" />}
			</div>
		);
	}

	const needsReadToken = data.problem && ["no-token", "bad-token", "no-zone", "no-access"].includes(data.problem.kind);
	const hasFixes = data.rows.some((r) => r.fix);
	// The last question stays in the dialog while it closes.
	if (asking) lastAsked.current = { fix: asking, value: data.rows.find((r) => r.fix === asking)?.value ?? null };
	const shown = lastAsked.current;
	const fix = shown ? data.fixes[shown.fix] : null;
	const canFix = Boolean(data.sharedToken) || data.setupToken.saved || Boolean(token.trim());

	return (
		<div className="space-y-6" aria-busy={loading}>
			{header}
			<div aria-live="polite">{error && <Banner variant="error" role="alert" description={error} />}</div>

			{data.problem && (
				<section className="space-y-3 rounded-lg border border-kumo-line p-4" aria-label="Cloudflare API token">
					<Banner variant={data.problem.kind === "error" ? "error" : "default"} description={data.problem.message} />
					{needsReadToken && (
						<div className="sm:max-w-md">
							<CredentialGuide id="checkup-read-token" />
						</div>
					)}
				</section>
			)}

			{data.zone && (
				<section className="rounded-lg border border-kumo-line p-4" aria-labelledby="cw-zone-title">
					<h2 id="cw-zone-title" className="text-base font-semibold">
						Zone: {data.zone.name}
					</h2>
					<p className="mt-1 max-w-3xl text-sm leading-5 text-pretty">{zoneReach(data)}</p>
					{data.otherHostsProblem && <p className="mt-1 text-sm text-kumo-subtle">{data.otherHostsProblem}</p>}
					<p className="mt-2 text-xs text-kumo-subtle">Checked {dateTime.format(new Date(data.checkedAt))}.</p>
				</section>
			)}

			{GROUPS.map((group) => {
				const rows = data.rows.filter((r) => r.group === group.id);
				if (!rows.length) return null;
				return (
					<section key={group.id} className="rounded-lg border border-kumo-line" aria-labelledby={`cw-group-${group.id}`}>
						<div className="border-b border-kumo-line p-4">
							<h2 id={`cw-group-${group.id}`} className="text-base font-semibold">
								{group.title}
							</h2>
							<p className="mt-1 text-sm text-kumo-subtle">{group.description}</p>
						</div>
						<ul className="divide-y divide-kumo-line">
							{rows.map((r) => (
								<RowItem key={r.id} row={r} busy={fixing || loading} fixes={data.fixes} onFix={(id) => {
									setFixError(null);
									setAsking(id);
								}} />
							))}
						</ul>
					</section>
				);
			})}

			{hasFixes && data.sharedToken && (
				<section className="rounded-lg border border-kumo-line p-4" aria-label="One-click fixes">
					<SharedTokenNote env={data.sharedTokenEnv} />
				</section>
			)}

			{!data.sharedToken && (hasFixes || data.setupToken.saved) && (
				<section className="rounded-lg border border-kumo-line" aria-labelledby="cw-setup-token">
					<div className="border-b border-kumo-line p-4">
						<h2 id="cw-setup-token" className="text-base font-semibold">
							Setup token
						</h2>
						<p className="mt-1 max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
							The one-click fixes change zone settings. They use the Cloudflare API token from the plugin's Settings page once it's saved (it needs Zone
							Settings → Edit). Until then, they use this older setup token: save it, or type it in and use it for the next fix without saving it.
						</p>
					</div>
					<div className="space-y-3 p-4">
						{data.setupToken.unreadable && (
							<Banner variant="error" description="The saved setup token can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed. Save it again." />
						)}
						<div className="sm:max-w-md">
							<SecretField
								label="Setup token"
								saved={data.setupToken.saved}
								value={token}
								onChange={setToken}
								description="Stored encrypted when saved. Only ever sent to api.cloudflare.com."
								onClear={() => void saveToken(true)}
								clearing={tokenBusy === "clear"}
								disabled={tokenBusy !== null}
							/>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button variant="secondary" disabled={!token.trim() || tokenBusy !== null} onClick={() => void saveToken(false)}>
								{tokenBusy === "save" ? "Saving…" : "Save token"}
							</Button>
						</div>
						<div className="sm:max-w-md">
							<CredentialGuide id="checkup-setup-token" />
						</div>
					</div>
				</section>
			)}

			<ConfirmDialog
				open={asking !== null}
				onClose={() => !fixing && setAsking(null)}
				title={fix ? `${fix.title} for ${data.zone?.name ?? "the zone"}?` : ""}
				description={
					fix && shown
						? `This changes one zone setting, ${fix.setting}, from ${shown.value ?? "its current value"} to ${fix.targetLabel}. Nothing else in the zone changes, and if it's already ${fix.targetLabel}, nothing changes at all.`
						: undefined
				}
				confirmLabel={fix?.button ?? "Apply"}
				pendingLabel="Changing…"
				variant="primary"
				isPending={fixing}
				confirmDisabled={!canFix}
				error={fixError ?? (canFix ? null : "Add the Cloudflare API token on the plugin's Settings page (or a setup token below the checkup) first, then try again.")}
				onConfirm={() => void applyFix()}
			>
				{fix && (
					<div className="space-y-2 text-sm leading-5">
						<p>{fix.effect}</p>
						<p className="font-medium">{zoneReach(data)}</p>
					</div>
				)}
			</ConfirmDialog>
		</div>
	);
}

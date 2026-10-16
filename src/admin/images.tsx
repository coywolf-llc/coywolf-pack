/**
 * Clean Image URLs page: the media host (status, a live check, the setting),
 * a step-by-step guide for setting it up by hand on Cloudflare, and Set up
 * media host, which does the same through the Cloudflare API (review, then
 * apply). The feature itself is turned on or off on the Coywolf Pack page.
 */
import { Banner, Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { ArrowsClockwise, CheckCircle, Info, MagnifyingGlass, Wrench, XCircle } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { type LibrarySummary, monthlyWithoutMax, oneTimeCost, paybackMonths, storageCost, trafficEstimate } from "../images/variants-estimate.js";
import { CredentialGuide } from "./guides.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SecretField, SettingsSection, errorText } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/images";

interface Settings {
	host: string;
	optionHost: string;
	activeHost: string;
	accountId: string;
	bucket: string;
	tokenSet: boolean;
	envToken: boolean;
	envAccountId: boolean;
	siteHost: string;
	quotaNote: string;
}

interface CheckItem {
	id: string;
	ok: boolean;
	label: string;
	detail: string;
}

interface CheckResult {
	host: string;
	file: string;
	ok: boolean;
	items: CheckItem[];
	quotaNote: string;
}

interface Plan {
	zone: string;
	plan: { host: string; done: boolean; steps: Array<{ id: string; action: string; label: string }> };
}

interface Applied {
	zone: string;
	results: Array<{ id: string; ok: boolean; message: string }>;
	check: CheckResult | null;
}

interface Draft {
	host: string;
	accountId: string;
	bucket: string;
	token: string;
}

const toDraft = (s: Settings): Draft => ({ host: s.host, accountId: s.accountId, bucket: s.bucket, token: "" });

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, fallback);
}

function StatusIcon({ ok }: { ok: boolean }) {
	return ok ? (
		<CheckCircle size={18} weight="fill" style={{ color: "var(--color-kumo-success, #16a34a)", flexShrink: 0 }} role="img" aria-label="Passed" />
	) : (
		<XCircle size={18} weight="fill" style={{ color: "var(--color-kumo-danger, #dc2626)", flexShrink: 0 }} role="img" aria-label="Failed" />
	);
}

/** Load an image in this browser; its natural size, or null when it fails. */
function loadImage(url: string): Promise<{ width: number; height: number } | null> {
	return new Promise((resolve) => {
		const img = new Image();
		const timer = window.setTimeout(() => resolve(null), 20_000);
		img.onload = () => {
			window.clearTimeout(timer);
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};
		img.onerror = () => {
			window.clearTimeout(timer);
			resolve(null);
		};
		img.src = url;
	});
}

/** Replace the server's fetch results with what this browser actually gets from the media host. */
async function browserCheck(result: CheckResult): Promise<CheckResult> {
	if (!result.file) return result;
	const stamp = Date.now().toString(36);
	const host = result.host.replace(/\/+$/, "");
	const [original, resized] = await Promise.all([loadImage(`${host}/${result.file}?check=${stamp}`), loadImage(`${host}/s/64x64/${result.file}`)]);
	const items: CheckItem[] = [
		{ id: "reachable", ok: Boolean(original || resized), label: "Host reachable", detail: original || resized ? "Your browser loaded images from the media host." : "Your browser couldn't load anything from the media host. Check the R2 custom domain and its DNS record." },
		{ id: "original", ok: Boolean(original), label: "Original served", detail: original ? `${result.file} (${original.width}×${original.height}).` : `${result.file} didn't load. Is the custom domain connected to the media bucket?` },
		{
			id: "resize",
			ok: Boolean(resized && resized.width === 64 && resized.height === 64),
			label: "Resize works",
			detail: !resized
				? "/s/64x64/ didn't load: the URL rewrite rules are missing, or Image Transformations are off for the zone."
				: resized.width === 64 && resized.height === 64
					? "/s/64x64/ came back at 64×64."
					: `/s/64x64/ came back at ${resized.width}×${resized.height}: the rewrite rules don't match this host.`,
		},
	];
	return { ...result, items, ok: items.every((i) => i.ok) };
}

function CheckList({ result }: { result: CheckResult }) {
	return (
		<div className="space-y-2" aria-live="polite">
			<p className="text-sm">
				Checked <span className="font-medium">{result.host}</span> with <code className="rounded bg-kumo-tint px-1 text-xs">{result.file}</code>:{" "}
				{result.ok ? "it works." : "something needs attention."}
			</p>
			<ul className="space-y-1.5">
				{result.items.map((item) => (
					<li key={item.id} className="flex items-start gap-2 text-sm">
						{item.id === "cached" && !item.ok ? (
							<Info size={18} style={{ flexShrink: 0 }} className="text-kumo-subtle" aria-label="Not yet" />
						) : (
							<StatusIcon ok={item.ok} />
						)}
						<span>
							<span className="font-medium">{item.label}.</span> <span className="text-kumo-subtle">{item.detail}</span>
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

interface VariantsStatus {
	available: boolean;
	reason?: string;
	/** Sizes for existing images (the backfill) are on. */
	bulk?: boolean;
	total?: number;
	stored?: number;
	skipped?: number;
	state?: { phase: "running" | "cleanup" | "done"; done: number; skipped: number; failed: number; finishedAt?: string; leaseUntil?: string; pausedUntil?: string; pauseReason?: string } | null;
	/** Images the running backfill handles an hour, from its start. */
	perHour?: number | null;
	crops: string[];
	fallbackNote: string;
}

interface Estimate extends LibrarySummary {
	/** Published pages; null when they couldn't be counted. */
	pages: number | null;
}

const count = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
const money = (n: number) => (n > 0 && n < 0.01 ? "less than $0.01" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const range = (r: { min: number; max: number }) => (r.max < 0.01 || money(r.min) === money(r.max) ? money(r.max) : `${money(r.min)}–${money(r.max)}`);
/** "about $1.20", or "less than $0.01" as it is (never "about less than"). */
const about = (s: string) => (s.startsWith("less") ? s : `about ${s}`);
const gb = (bytes: number) => (bytes < 1e9 ? `${Math.max(1, Math.round(bytes / 1e6)).toLocaleString("en-US")} MB` : `${(bytes / 1e9).toFixed(1)} GB`);
const payback = (months: number | null) =>
	months === null ? "doesn't pay for itself at this traffic" : months <= 1 ? "pays for itself in the first month" : `pays for itself in about ${months} months`;

/** What stored sizes cost, what they save, and a traffic calculator (all computed here from one fetch). */
function CostEstimate({ estimate }: { estimate: Estimate }) {
	const [views, setViews] = React.useState("10000");
	const [crawlers, setCrawlers] = React.useState(true);
	const oneTime = oneTimeCost(estimate.transforms);
	const storage = storageCost(estimate.bytes);
	const upTo = monthlyWithoutMax(estimate.sizes);
	const viewsNumber = Math.max(0, Number(views) || 0);
	const traffic = estimate.pages
		? trafficEstimate({ views: viewsNumber, pages: estimate.pages, images: estimate.images, sizes: estimate.sizes, bytes: estimate.bytes, crawlers })
		: null;
	if (!estimate.images) return <p className="text-sm text-kumo-subtle">The media library has no images that can get stored sizes yet.</p>;
	return (
		<div className="space-y-3 rounded-md border border-kumo-line p-3">
			<p className="text-sm font-medium">
				What it costs: {count(estimate.images)} images, {count(estimate.done)} with their sizes
			</p>
			<ul className="list-disc space-y-1.5 cw-ps-6 text-sm">
				<li>
					{estimate.transforms ? (
						<>
							<span className="font-medium">One time: {about(range(oneTime))}.</span> Making the missing sizes is {count(estimate.transforms)} Cloudflare image
							transformations ({count(estimate.filesLeft)} files) at $0.50 per 1,000, made once. The first 5,000 each month are free, but the site may
							already have used them this month, hence the range.
						</>
					) : (
						<>
							<span className="font-medium">One time: nothing left to pay.</span> Every image has its sizes.
						</>
					)}
				</li>
				<li>
					<span className="font-medium">Then {about(money(storage))} a month</span> to keep {count(estimate.files)} files (about {gb(estimate.bytes)}) in the
					media bucket, at R2's $0.015 per GB a month (less while the bucket is under R2's free 10 GB). Serving them costs no transformations.
				</li>
				<li>
					<span className="font-medium">Without stored sizes: up to {money(upTo)} a month.</span> Cloudflare charges for each different size of each image
					that's asked for, every month (AVIF and WebP of one size count once). That's if all {count(estimate.sizes)} sizes are asked for in a month, after
					the free 5,000.{" "}
					{upTo > storage
						? `At that most, making them ${payback(paybackMonths(oneTime.max, upTo - storage))}.`
						: "That fits in the free 5,000, so here stored sizes are about faster pages, not savings."}
				</li>
				<li>Crops (thumbnails, avatars) are made as pages first show them, only for the images that use them: usually a few cents.</li>
			</ul>

			{traffic ? (
				<div className="space-y-2">
					<div className="grid gap-3 sm:grid-cols-2 sm:items-end">
						<Input
							type="number"
							min={0}
							label="Page views per month"
							value={views}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setViews(e.target.value)}
						/>
						<Checkbox label="Search engines crawl the site" checked={crawlers} onCheckedChange={(checked: boolean) => setCrawlers(checked)} />
					</div>
					<table className="w-full text-sm" aria-live="polite">
						<tbody>
							<tr className="border-b border-kumo-line">
								<th scope="row" className="py-1.5 pr-3 text-left font-normal text-kumo-subtle">Without stored sizes</th>
								<td className="py-1.5 font-medium">
									{money(traffic.withoutCost)} a month <span className="font-normal text-kumo-subtle">({count(traffic.withoutTransforms)} transformations)</span>
								</td>
							</tr>
							<tr className="border-b border-kumo-line">
								<th scope="row" className="py-1.5 pr-3 text-left font-normal text-kumo-subtle">With stored sizes</th>
								<td className="py-1.5 font-medium">
									{money(traffic.withCost)} a month <span className="font-normal text-kumo-subtle">(storage, plus {count(traffic.withTransforms)} Open Graph images)</span>
								</td>
							</tr>
							<tr className="border-b border-kumo-line">
								<th scope="row" className="py-1.5 pr-3 text-left font-normal text-kumo-subtle">One-time fee</th>
								<td className="py-1.5 font-medium">{estimate.transforms ? about(range(oneTime)) : "none left"}</td>
							</tr>
							<tr>
								<th scope="row" className="py-1.5 pr-3 text-left font-normal text-kumo-subtle">Payback</th>
								<td className="py-1.5 font-medium">
									{!estimate.transforms
										? "—"
										: traffic.withoutCost === 0
											? "no savings: at this traffic, /s/ stays within the free 5,000 a month"
											: payback(paybackMonths(oneTime.max, traffic.savings))}
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			) : (
				<p className="text-sm text-kumo-subtle">
					{estimate.pages === 0
						? "The traffic calculator needs published pages; the site has none yet."
						: "The traffic calculator needs the number of published pages, which couldn't be counted."}
				</p>
			)}

			<details className="text-xs text-kumo-subtle">
				<summary className="cursor-pointer" style={{ display: "list-item" }}>
					How this is estimated
				</summary>
				<div className="mt-2 space-y-1.5">
					<p>
						Counts come from the media library: each JPEG, PNG or WebP image up to 20 MB gets the widths 400, 640, 800, 1200 and 1600 that are smaller than
						the original, each as WebP and AVIF (two transformations; one above 1,200 pixels, where Cloudflare stores WebP for both). File sizes are rough
						averages per width.
					</p>
					<p>
						Traffic: {estimate.pages ? count(estimate.pages) : "the"} published pages, with the images spread evenly over them. With V page views spread evenly
						over P pages, about P × (1 − e^(−V/P)) different pages are seen in a month; real traffic favors some pages, so it's usually fewer. With search
						engines crawling, at least 80% of pages are assumed to be fetched each month. Each image shown is asked for in about 3 sizes (phones, tablets,
						desktops), fewer when it has fewer. Each page's Open Graph image stays a /s/ transformation either way. Monthly costs subtract the free 5,000.
					</p>
				</div>
			</details>
		</div>
	);
}

/** Where a backfill run is, in words: working (and how fast), or paused (and until when). */
function progressText(state: NonNullable<VariantsStatus["state"]>, perHour: number | null | undefined): string {
	const made = `${count(state.done)} made so far`;
	if (state.pausedUntil && Date.parse(state.pausedUntil) > Date.now()) {
		const at = new Date(state.pausedUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
		return `paused until about ${at} (${state.pauseReason ?? "Cloudflare Images refused work"}); it picks up on its own · ${made}`;
	}
	if (state.phase === "cleanup") return `finishing up · ${made}`;
	return `working${perHour ? `, about ${count(perHour)} images an hour` : ""} · ${made}`;
}

/** Stored image sizes: how many images have them, the cost estimate, and the opt-in for existing images. */
function StoredSizes() {
	const [status, setStatus] = React.useState<VariantsStatus | null>(null);
	const [estimate, setEstimate] = React.useState<Estimate | null>(null);
	const [running, setRunning] = React.useState(false);
	const [confirming, setConfirming] = React.useState(false);
	const [switching, setSwitching] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const stop = React.useRef(false);

	const loadEstimate = async () => {
		try {
			setEstimate(await parseApiResponse<Estimate>(await apiFetch(`${API}/variants/estimate`), "Couldn't load the estimate"));
		} catch {
			setEstimate(null);
		}
	};

	React.useEffect(() => {
		void (async () => {
			try {
				const next = await parseApiResponse<VariantsStatus>(await apiFetch(`${API}/variants/settings`), "Couldn't load the stored sizes");
				setStatus(next);
				if (next.available) await loadEstimate();
				// A run under way (started here earlier, by the hourly job or an import): show its progress.
				if (next.bulk && next.state && next.state.phase !== "done" && !next.state.pausedUntil) void watch();
			} catch (cause) {
				setError(errorText(cause, "Couldn't load the stored sizes"));
			}
		})();
		return () => {
			stop.current = true;
		};
	}, []);

	/** While a run is under way, read its progress every few seconds (the server works on its own; this only watches). */
	const watch = async () => {
		setRunning(true);
		stop.current = false;
		try {
			for (let i = 0; i < 2000 && !stop.current; i++) {
				await new Promise((resolve) => setTimeout(resolve, 5000));
				if (stop.current) break;
				const next = await parseApiResponse<VariantsStatus>(await apiFetch(`${API}/variants/settings`), "Couldn't load the stored sizes");
				if (stop.current) break;
				setStatus(next);
				if (!next.bulk || !next.state || next.state.phase === "done" || next.state.pausedUntil) break;
			}
		} catch (cause) {
			setError(errorText(cause, "Couldn't load the stored sizes"));
		} finally {
			setRunning(false);
			void loadEstimate();
		}
	};

	/** "Make missing sizes now": start a new run (its chain works in the background), then watch it. */
	const run = async () => {
		setError(null);
		try {
			setStatus(await post<VariantsStatus>("variants/run", { start: true }, "Couldn't make the sizes"));
		} catch (cause) {
			setError(errorText(cause, "Couldn't make the sizes"));
			return;
		}
		void watch();
	};

	const setBulk = async (on: boolean) => {
		setSwitching(true);
		setError(null);
		if (!on) stop.current = true;
		let turnedOn = false;
		try {
			setStatus(await post<VariantsStatus>("variants/bulk", { on }, "Couldn't change the setting"));
			setConfirming(false);
			turnedOn = on;
		} catch (cause) {
			setError(errorText(cause, "Couldn't change the setting"));
		} finally {
			setSwitching(false);
		}
		// The first run starts on the server, in the background: Turn off stays usable while it works.
		if (turnedOn) void watch();
	};

	const state = status?.state;
	const oneTime = estimate ? oneTimeCost(estimate.transforms) : null;
	return (
		<SettingsSection
			id="images-variants"
			title="Stored image sizes"
			description="Each image is stored once in a few widths (and the theme's crops) as AVIF and WebP on the media host, so pages load small, ready-made files instead of resizing on each visit."
			actions={
				status?.available && status.bulk ? (
					<Button type="button" variant="secondary" icon={<ArrowsClockwise />} disabled={running || switching} onClick={() => void run()}>
						{running ? "Making sizes…" : "Make missing sizes now"}
					</Button>
				) : undefined
			}
		>
			{error && <Banner variant="error" role="alert" description={error} />}
			{!status && !error && <Loader />}
			{status && !status.available && <p className="text-sm text-kumo-subtle">{status.reason}</p>}
			{status?.available && (
				<p className="text-sm" aria-live="polite">
					<span className="font-medium">
						{count(status.stored)} of {count(status.total)} images have stored sizes
					</span>
					{status.skipped ? ` · ${count(status.skipped)} skipped (no known width or over 20 MB)` : ""}
					{status.bulk && state?.failed ? ` · ${count(state.failed)} failed in the last run (tried again later)` : ""}
					{status.bulk && state && state.phase !== "done" ? ` · ${progressText(state, status.perHour)}` : ""}
				</p>
			)}

			{status?.available && (
				<div className="space-y-2 rounded-md border border-kumo-line p-3">
					{status.bulk ? (
						<>
							<p className="text-sm">
								<span className="font-medium">Sizes for existing images: on.</span> Missing sizes are made in the background, batch after batch, until
								every image has them (also right after a WordPress media import; an hourly job picks up anything left). When a run is done, cached pages
								are cleared once so they use the new sizes. Turning it off stops that; sizes already made stay in use.
							</p>
							<Button type="button" variant="secondary" disabled={switching} onClick={() => void setBulk(false)}>
								{switching ? "Turning off…" : "Turn off"}
							</Button>
						</>
					) : confirming ? (
						<>
							<p className="text-sm font-medium">
								{estimate && oneTime
									? estimate.transforms
										? `Make sizes for ${count(estimate.images - estimate.done)} existing images? It's a one-time fee of ${about(range(oneTime))} (${count(estimate.transforms)} transformations).`
										: "Every image already has its sizes; turning this on keeps it that way for imports."
									: "Make sizes for existing images? It's a one-time fee for Cloudflare transformations (the estimate couldn't be loaded)."}
							</p>
							<p className="text-xs text-kumo-subtle">
								On Cloudflare's Free plan, transformations beyond 5,000 a month aren't charged; they stop until the next month, and the job picks up where it
								left off.
							</p>
							<div className="flex flex-wrap gap-2">
								<Button type="button" variant="primary" disabled={switching} onClick={() => void setBulk(true)}>
									{switching ? "Turning on…" : "Turn on and start"}
								</Button>
								<Button type="button" variant="secondary" disabled={switching} onClick={() => setConfirming(false)}>
									Cancel
								</Button>
							</div>
						</>
					) : (
						<>
							<p className="text-sm">
								<span className="font-medium">Sizes for existing images: off.</span> New uploads always get their sizes. Images that were already in the
								library (including WordPress imports) keep using the media host's /s/ resizing until you turn this on.
							</p>
							<Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
								Make sizes for existing images…
							</Button>
						</>
					)}
				</div>
			)}

			{status?.available && estimate && <CostEstimate estimate={estimate} />}

			{status && (
				<p className="text-xs text-kumo-subtle">
					Widths: 400, 640, 800, 1200 and 1600 pixels (only those smaller than the original).{" "}
					{status.crops.length ? `Crops, made when first shown: ${status.crops.join(", ")}.` : "Crops: none (set images.crops in astro.config.mjs)."}
				</p>
			)}
			{status && <p className="text-xs text-kumo-subtle">{status.fallbackNote}</p>}
		</SettingsSection>
	);
}

export function ImagesPage() {
	const [saved, setSaved] = React.useState<Settings | null>(null);
	const [draft, setDraft] = React.useState<Draft>({ host: "", accountId: "", bucket: "", token: "" });
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState("");
	const [pending, setPending] = React.useState<"save" | "clear" | "check" | "plan" | "apply" | undefined>();
	const [check, setCheck] = React.useState<CheckResult | null>(null);
	const [plan, setPlan] = React.useState<Plan | null>(null);
	const [applied, setApplied] = React.useState<Applied | null>(null);
	// A working media host hides the host field and the setup form until asked for.
	const [hostOpen, setHostOpen] = React.useState(false);
	const [setupOpen, setSetupOpen] = React.useState(false);
	// The check on page load runs on its own, outside `pending`: it must not lock the form (it can take a while
	// when the host is down), only the Check button, so two checks never race.
	const [autoChecking, setAutoChecking] = React.useState(false);
	const autoChecked = React.useRef(false);

	const apply = (s: Settings) => {
		setSaved(s);
		setDraft(toDraft(s));
	};

	React.useEffect(() => {
		void (async () => {
			try {
				apply(await parseApiResponse<Settings>(await apiFetch(`${API}/settings`), "Couldn't load the settings"));
			} catch (cause) {
				setError(errorText(cause, "Couldn't load the settings"));
			}
		})();
	}, []);

	const set = (patch: Partial<Draft>) => {
		setDraft((d) => ({ ...d, ...patch }));
		// A changed host, account or bucket makes the reviewed plan stale.
		if ("host" in patch || "accountId" in patch || "bucket" in patch) setPlan(null);
	};

	const save = async (clearToken = false) => {
		setPending(clearToken ? "clear" : "save");
		setError(null);
		setNotice("");
		try {
			const { token, ...rest } = draft;
			apply(await post<Settings>("settings/save", { ...rest, ...(clearToken ? { clearToken: true } : token.trim() ? { token: token.trim() } : {}) }, "Couldn't save"));
			setNotice(clearToken ? "API token removed." : "Saved. The site picks up a new media host within a minute.");
		} catch (cause) {
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setPending(undefined);
		}
	};

	const hostToUse = draft.host.trim() || saved?.activeHost || "";
	const suggestedHost = saved?.siteHost ? `media.${saved.siteHost}` : "media.example.com";
	const setupHost = draft.host.trim() || saved?.activeHost || suggestedHost;

	const runCheck = async (quiet = false) => {
		if (quiet) setAutoChecking(true);
		else {
			setPending("check");
			setError(null);
		}
		setCheck(null);
		try {
			// The server picks a recent image from the media library. The loading itself is checked here, in the
			// browser: requests from the site's own Worker to the media host skip the zone's rewrite rules and can
			// be challenged by Bot Fight Mode, so only a visitor's view is meaningful.
			const result = await post<CheckResult>("check", { host: hostToUse }, "Couldn't check the media host");
			setCheck(await browserCheck(result));
		} catch (cause) {
			// The check on page load stays quiet: the setup form simply shows, as when the host doesn't work.
			if (!quiet) setError(errorText(cause, "Couldn't check the media host"));
		} finally {
			if (quiet) setAutoChecking(false);
			else setPending(undefined);
		}
	};

	const setupBody = () => ({
		host: setupHost,
		...(draft.accountId.trim() ? { accountId: draft.accountId.trim() } : {}),
		...(draft.bucket.trim() ? { bucket: draft.bucket.trim() } : {}),
		...(draft.token.trim() ? { token: draft.token.trim() } : {}),
	});

	const review = async () => {
		setPending("plan");
		setError(null);
		setPlan(null);
		setApplied(null);
		try {
			setPlan(await post<Plan>("setup/plan", setupBody(), "Couldn't read the Cloudflare setup"));
		} catch (cause) {
			setError(errorText(cause, "Couldn't read the Cloudflare setup"));
		} finally {
			setPending(undefined);
		}
	};

	const applySetup = async () => {
		setPending("apply");
		setError(null);
		try {
			const result = await post<Applied>("setup/apply", setupBody(), "Couldn't set up the media host");
			setApplied(result);
			setPlan(null);
			if (result.check) setCheck(result.check);
			// Fill in the host so saving starts using it.
			if (result.results.every((r) => r.ok) && !draft.host.trim() && !saved?.activeHost) set({ host: `https://${setupHost.replace(/^https?:\/\//, "")}` });
		} catch (cause) {
			setError(errorText(cause, "Couldn't set up the media host"));
		} finally {
			setPending(undefined);
		}
	};

	// Check the media host once on load, so a working setup can be shown as done.
	React.useEffect(() => {
		if (!saved?.activeHost || autoChecked.current) return;
		autoChecked.current = true;
		void runCheck(true);
	}, [saved?.activeHost]);

	const bare = (host: string) => host.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
	const hostWorks = Boolean(saved?.activeHost && check?.ok && bare(check.host) === bare(saved.activeHost));
	// Only the check on load collapses the setup form to "Checking…"; a Check the user asks for leaves the page as it is.
	const firstCheck = autoChecking && !setupOpen;
	const showHostInput = !saved?.activeHost || hostOpen || draft.host !== (saved?.host ?? "");
	const setupDone = (hostWorks || firstCheck) && !setupOpen && !plan && !applied;

	const dirty = saved ? isDirty(draft, toDraft(saved)) : false;
	const busy = Boolean(pending);
	const checking = pending === "check" || autoChecking;
	const changes = plan?.plan.steps.filter((s) => s.action !== "none").length ?? 0;

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Clean Image URLs</h1>
					<div />
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Resized images at short, cacheable addresses. With a media host, images are served and resized by Cloudflare at
						addresses like media.example.com/s/600x315/&lt;file&gt; and never touch the site's Worker. Without one, they're
						served at /media/&lt;id&gt;-600x315.webp.
					</p>
				</div>
			</header>

			{error && <Banner variant="error" role="alert" description={error} />}
			<p className="sr-only" role="status" aria-live="polite">
				{notice}
			</p>
			{notice && !busy && <p className="text-sm text-kumo-subtle">{notice}</p>}

			{!saved && !error && (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			)}

			{saved && (
				<form
					id="cw-images-form"
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<SettingsSection
						id="images-status"
						title="Media host"
						description={
							saved.activeHost ? (
								<>
									Images use <span className="font-medium">{saved.activeHost}</span>
									{saved.host ? " (saved here)" : " (from astro.config.mjs)"}. Old /media/ addresses redirect there.
								</>
							) : (
								"None yet: images use the site's /media/ addresses, resized by the Worker."
							)
						}
						actions={
							<>
								{!showHostInput && (
									<Button type="button" variant="secondary" disabled={busy} onClick={() => setHostOpen(true)}>
										Change host
									</Button>
								)}
								<Button type="button" variant="secondary" icon={<MagnifyingGlass />} disabled={busy || checking || !hostToUse} onClick={() => void runCheck()}>
									{checking ? "Checking…" : "Check"}
								</Button>
							</>
						}
					>
						{showHostInput && (
							<Input
								label="Media host"
								placeholder={`https://${suggestedHost}`}
								description={
									saved.optionHost
										? `Leave empty to use the one in astro.config.mjs (${saved.optionHost}). Check it before saving: images switch to it right away.`
										: "An https address like https://media.example.com. Check it before saving: images switch to it right away."
								}
								value={draft.host}
								disabled={busy}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ host: e.target.value })}
							/>
						)}
						{check && <CheckList result={check} />}
						<p className="text-xs text-kumo-subtle">{saved.quotaNote}</p>
						{!hostWorks && <CredentialGuide id="media-host" />}
					</SettingsSection>

					{setupDone ? (
						<SettingsSection
							id="images-setup"
							title="Set up media host"
							description={
								firstCheck ? (
									"Checking the media host…"
								) : (
									<>
										Done: <span className="font-medium">{bare(saved.activeHost)}</span> serves the media bucket and resizes images (checked just
										now). Run the setup again only to repair it or to set up a different host.
									</>
								)
							}
							actions={
								<Button type="button" variant="secondary" icon={<Wrench />} disabled={busy} onClick={() => setSetupOpen(true)}>
									Run setup again
								</Button>
							}
						/>
					) : (
						<SettingsSection
							id="images-setup"
							title="Set up media host"
							description={
								<>
									Optional: does the Cloudflare setup for you, for <span className="font-medium">{setupHost.replace(/^https?:\/\//, "")}</span>. It turns
									on Image Transformations for the zone, connects the host to the media bucket, and adds the two URL rewrite rules,
									skipping anything already done. You'll see the plan before anything changes.
								</>
							}
							actions={
								<Button type="button" variant="secondary" icon={<Wrench />} disabled={busy} onClick={() => void review()}>
									{pending === "plan" ? "Reading…" : "Review setup"}
								</Button>
							}
						>
							<div className="grid gap-4 sm:grid-cols-2">
								<Input
									label="Cloudflare account ID"
									description={saved.envAccountId ? "CF_ACCOUNT_ID is set; it's used when this is empty." : undefined}
									value={draft.accountId}
									disabled={busy}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ accountId: e.target.value })}
								/>
								<Input
									label="R2 bucket name"
									description="The bucket bound as MEDIA in wrangler.jsonc (its bucket_name)."
									value={draft.bucket}
									disabled={busy}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ bucket: e.target.value })}
								/>
								<SecretField
									label="Cloudflare API token"
									saved={saved.tokenSet}
									value={draft.token}
									onChange={(value) => set({ token: value })}
									description={
										saved.envToken
											? "A Worker secret (IMAGES_API_TOKEN or CLOUDFLARE_API_TOKEN) is set; it's used when no token is saved here."
											: "Used only for this setup. Saving it is optional (stored encrypted)."
									}
									onClear={() => void save(true)}
									clearing={pending === "clear"}
									disabled={busy}
								/>
							</div>
							<CredentialGuide id="images-token" />

							{plan && (
								<div className="space-y-3 rounded-md border border-kumo-line p-3" aria-live="polite">
									<p className="text-sm font-medium">
										{plan.plan.done ? `Everything is already set up on ${plan.zone}.` : `Plan for ${plan.zone} (${changes} change${changes === 1 ? "" : "s"}):`}
									</p>
									<ul className="space-y-1.5">
										{plan.plan.steps.map((step) => (
											<li key={step.id} className="flex items-start gap-2 text-sm">
												{step.action === "none" ? <StatusIcon ok /> : <Wrench size={18} style={{ flexShrink: 0 }} aria-label="Will change" />}
												<span className={step.action === "none" ? "text-kumo-subtle" : undefined}>{step.label}</span>
											</li>
										))}
									</ul>
									{!plan.plan.done && (
										<div className="flex flex-wrap gap-2">
											<Button type="button" variant="primary" disabled={busy} onClick={() => void applySetup()}>
												{pending === "apply" ? "Setting up…" : "Apply"}
											</Button>
											<Button type="button" variant="secondary" disabled={busy} onClick={() => setPlan(null)}>
												Cancel
											</Button>
										</div>
									)}
								</div>
							)}

							{applied && (
								<div className="space-y-2" aria-live="polite">
									<ul className="space-y-1.5">
										{applied.results.map((r) => (
											<li key={r.id} className="flex items-start gap-2 text-sm">
												<StatusIcon ok={r.ok} />
												<span>{r.message}</span>
											</li>
										))}
									</ul>
									{applied.results.every((r) => r.ok) && (
										<p className="text-sm text-kumo-subtle">
											{applied.check?.ok
												? "The media host works. Save to start using it."
												: "Done. A new custom domain can take a few minutes to get its certificate: select Check again shortly, then save."}
										</p>
									)}
								</div>
							)}
						</SettingsSection>
					)}
				</form>
			)}

			{saved && <StoredSizes />}

			{saved && <SaveBar form="cw-images-form" dirty={dirty} saving={pending === "save"} canSave={!busy} onDiscard={() => apply(saved)} />}
		</div>
	);
}

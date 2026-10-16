/**
 * WordPress import page: the steps for finishing a move from WordPress to
 * EmDash, for any WordPress site, plus a section for sites that used
 * Coywolf's WordPress plugins. Reading the export runs in the browser (the
 * file never leaves the computer until it's imported); converting stored
 * content runs on the site, a dry run first. Turning the module on or off
 * happens on the Coywolf Pack page.
 */
import { Banner, Button, Input, InputArea, Loader } from "@cloudflare/kumo";
import {
	ArrowsClockwise,
	ArrowsLeftRight,
	DownloadSimple,
	FileArrowUp,
	ImageSquare,
	MagnifyingGlass,
	TreeStructure,
	UploadSimple,
	UserPlus,
} from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { type GuestAuthor, type GuestByline, type PostCredit, groupGuests, postCredits, sameName, wxrGuestAuthors } from "../wpImport/guests.js";
import { type ParentPlan, type SiteTerm, type WxrCategory, type WxrPage, optionSnippet, parentsMap, planCategoryParents, wxrCategories, wxrPages } from "../wpImport/parents.js";
import { type PrepareWxrResult, prepareWxr, wxrAttachments } from "../wpImport/prepare.js";
import {
	type RedirectsResult,
	type WpRedirect,
	coywolfSeoRules,
	mergeRedirects,
	rankMathRules,
	redirectionRules,
	wxrOldSlugRules,
	yoastRules,
} from "../wpImport/redirects.js";
import { parseFileRows } from "../wpImport/sources.js";
import { type MediaFile, type SiteInfo, type SiteUrlPlan, parseHosts, planSiteUrls, rewriteMap, sourceUrl, uploadRedirects, wxrSite } from "../wpImport/urls.js";
import { saveFile } from "./download.js";

const API = "/_emdash/api/plugins/coywolf-pack/wpImport";
const EMDASH = "/_emdash/api";

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, fallback);
}

async function getJson<T>(url: string, fallback: string): Promise<T> {
	return parseApiResponse<T>(await apiFetch(url), fallback);
}

async function send<T>(url: string, method: "POST" | "PUT", body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return parseApiResponse<T>(response, fallback);
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Section(props: { title: string; description: React.ReactNode; children?: React.ReactNode }) {
	const id = `cw-wpi-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={id}>
			<div className={props.children ? "border-b border-kumo-line p-4" : "p-4"}>
				<h2 id={id} className="text-base font-semibold">
					{props.title}
				</h2>
				<div className="mt-1 text-sm text-kumo-subtle">{props.description}</div>
			</div>
			{props.children && <div className="space-y-4 p-4">{props.children}</div>}
		</section>
	);
}

const Code = ({ children }: { children: string }) => <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs break-all">{children}</code>;

function CountsTable({ counts, label = "Block" }: { counts: Record<string, number>; label?: string }) {
	const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	if (!rows.length) return <p className="text-sm text-kumo-subtle">Nothing to change.</p>;
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-left text-sm">
				<thead className="text-kumo-subtle">
					<tr>
						<th className="py-1 pe-3 font-medium">{label}</th>
						<th className="py-1 text-end font-medium">Count</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(([k, v]) => (
						<tr key={k} className="border-t border-kumo-line">
							<td className="py-1 pe-3 font-mono text-xs">{k}</td>
							<td className="py-1 text-end tabular-nums">{v.toLocaleString()}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// ── The export, read once ────────────────────────────────────────

interface WxrParents {
	categories: WxrCategory[];
	pages: WxrPage[];
}

/** What the steps after importing need from the export. */
interface WxrInfo {
	guests: GuestAuthor[];
	parents: WxrParents;
	site: SiteInfo;
	/** Attachment URLs (wp:attachment_url). */
	attachmentUrls: string[];
	oldSlugs: RedirectsResult;
}

function readWxr(xml: string, prepared?: PrepareWxrResult): WxrInfo {
	const attachments = wxrAttachments(xml);
	return {
		guests: prepared?.guestAuthors ?? wxrGuestAuthors(xml, attachments),
		parents: { categories: prepared?.categories ?? wxrCategories(xml), pages: prepared?.pages ?? wxrPages(xml) },
		site: wxrSite(xml),
		attachmentUrls: [...attachments.values()],
		oldSlugs: wxrOldSlugRules(xml),
	};
}

async function readExportFile(file: File): Promise<string> {
	const xml = await file.text();
	if (!xml.includes("<rss") || !xml.includes("<wp:")) throw new Error("That doesn't look like a WordPress export (WXR) file.");
	return xml;
}

/** A hidden file input and the button that opens it. */
function ChooseExport({ onXml, disabled, label = "Choose export file" }: { onXml: (xml: string, name: string) => void | Promise<void>; disabled?: boolean; label?: string }) {
	const fileRef = React.useRef<HTMLInputElement>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const choose = async (file: File) => {
		setBusy(true);
		setError(undefined);
		try {
			const xml = await readExportFile(file);
			// Let the "Reading…" state paint before the synchronous work.
			await new Promise((r) => setTimeout(r, 0));
			await onXml(xml, file.name);
		} catch (cause) {
			setError(errorText(cause, "Could not read that file."));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<input
				ref={fileRef}
				type="file"
				accept=".xml,text/xml,application/xml"
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void choose(file);
				}}
			/>
			<Button variant="secondary" icon={<FileArrowUp />} disabled={busy || disabled} onClick={() => fileRef.current?.click()}>
				{busy ? "Reading…" : label}
			</Button>
			{error && <Banner variant="error" role="alert" description={error} />}
		</>
	);
}

// ── Before you import ────────────────────────────────────────────

function BeforeImport() {
	return (
		<Section
			title="Before you import"
			description={
				<ul className="list-disc space-y-1 ps-5">
					<li>
						Install EmDash and Coywolf Pack first, and add API keys and tokens (under <strong>Plugins → Coywolf Pack → Settings</strong> or on each
						module's page) before importing, so imported content comes over connected.
					</li>
					<li>
						Turn on the modules imported content needs, under <strong>Plugins → Coywolf Pack</strong>: <strong>WordPress import</strong>,{" "}
						<strong>Headings &amp; TOC</strong> with Heading anchors (WordPress heading ids), <strong>Custom Blocks</strong> with the Details block (core
						Details blocks), and <strong>Redirects</strong> (old URLs). Sites that used Coywolf's WordPress plugins turn on more; see “Coywolf
						WordPress plugins” below.
					</li>
					<li>
						Keep the WordPress site online until you finish: EmDash imports media from it, and step 5 downloads files that weren't in the media
						library. Make a backup of the EmDash site before converting.
					</li>
				</ul>
			}
		/>
	);
}

// ── 1. Prepare ───────────────────────────────────────────────────

function PrepareStep({ onWxr }: { onWxr: (info: WxrInfo) => void }) {
	const [result, setResult] = React.useState<(PrepareWxrResult & { name: string }) | null>(null);
	const [disclosures, setDisclosures] = React.useState("");

	const prepare = (xml: string, name: string) => {
		setResult(null);
		const disclosureBlocks = disclosures
			.split(/[\s,]+/)
			.map((b) => b.trim())
			.filter((b) => /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(b));
		const prepared = prepareWxr(xml, { disclosureBlocks });
		setResult({ ...prepared, name });
		onWxr(readWxr(xml, prepared));
	};

	const changed: Record<string, number> = {};
	const dropped: Record<string, number> = {};
	for (const [k, v] of Object.entries(result?.counts ?? {})) {
		if (k.endsWith("→ dropped") || k.endsWith("→ missing")) dropped[k.replace(/ → (dropped|missing)$/, (_, a: string) => (a === "missing" ? " (reusable block not in the export)" : ""))] = v;
		else changed[k] = v;
	}
	const parentCount = result ? Object.keys(parentsMap(result.categories)).length + Object.keys(parentsMap(result.pages)).length : 0;

	return (
		<Section
			title="1. Prepare the WordPress export"
			description={
				<>
					EmDash's importer drops heading ids, reusable blocks, Details summaries and self-closing blocks it doesn't know. Choose the export from{" "}
					<strong>Tools → Export → All content</strong> in WordPress, then import the prepared copy under <strong>Settings → Import</strong>. The file
					is processed in your browser and isn't uploaded.
				</>
			}
		>
			<div className="max-w-xl space-y-1">
				<Input
					label="More affiliate disclosure blocks (optional)"
					placeholder="genesis-custom-blocks/disclosure"
					value={disclosures}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDisclosures(e.target.value)}
				/>
				<p className="text-xs text-kumo-subtle">
					Block names, separated by commas, of self-closing blocks that printed an affiliate disclosure. They become Affiliate disclosure blocks with
					the wording on the Custom Blocks page.
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<ChooseExport onXml={prepare} />
				{result && (
					<Button
						variant="primary"
						icon={<DownloadSimple />}
						onClick={() => saveFile(new Blob([result.xml], { type: "application/xml" }), result.name.replace(/\.xml$/i, "") + "-prepared.xml")}
					>
						Download prepared file
					</Button>
				)}
			</div>
			{result && (
				<div className="space-y-3" role="status">
					<p className="text-sm">
						{plural(result.posts.length, "entry", "entries")} changed. “→ anchor” keeps a heading id, “→ caption” keeps a table's caption, “→ inlined” puts a reusable block's content in
						place, “→ details”, “→ note”, “→ quote”, “→ disclosure”, “→ testimonial” and “→ podcast” become Custom Blocks, “→ html” keeps content as an
						HTML block, “→ flag” leaves an empty marker for the theme, and “→ removed” rendered nothing on WordPress.
						{result.guestAuthors.length ? ` ${plural(postCredits(result.guestAuthors).length, "post has", "posts have")} co-authors or guest authors: credit them in step 3 after importing.` : ""}
						{parentCount ? " Some categories or pages have parents, which EmDash's importer drops: restore them in step 4 after importing." : ""}
					</p>
					<CountsTable counts={changed} />
					{Object.keys(dropped).length > 0 && (
						<div>
							<h3 className="mb-1 text-sm font-medium">Blocks EmDash will drop</h3>
							<p className="mb-1 text-xs text-kumo-subtle">
								Self-closing blocks keep everything in their settings, and EmDash's importer drops the ones it doesn't know. Rebuild them after
								importing (a pack block, an embed, or the theme).
							</p>
							<CountsTable counts={dropped} />
						</div>
					)}
				</div>
			)}
		</Section>
	);
}

// ── 2. Convert (and rewrite URLs) ────────────────────────────────

interface ScanEntry {
	collection: string;
	id: string;
	title: string;
	status: string;
	changes: Record<string, number>;
	result?: string;
	error?: string;
}

interface ScanPage {
	done: boolean;
	scanned: number;
	entries: ScanEntry[];
	leftovers: Record<string, number>;
	videosAdded: number;
	state: unknown;
	progress: string;
}

interface ScanReport {
	apply: boolean;
	scanned: number;
	entries: ScanEntry[];
	leftovers: Record<string, number>;
	videosAdded: number;
	done: boolean;
}

const RESULT_LABEL: Record<string, string> = {
	updated: "Updated",
	published: "Updated and republished",
	draft: "Updated in its draft (it had unpublished changes)",
	conflict: "Skipped: changed while converting",
	failed: "Failed",
};

/** Dry run and apply of the content scan; with `urlMap`, it also rewrites old-site URLs. */
function ScanPanel({ urlMap, applyLabel, confirmText }: { urlMap?: Record<string, string>; applyLabel: string; confirmText: string }) {
	const [report, setReport] = React.useState<ScanReport | null>(null);
	const [running, setRunning] = React.useState<false | "dry" | "apply">(false);
	const [progress, setProgress] = React.useState("");
	const [error, setError] = React.useState<string>();
	const [dryRunDone, setDryRunDone] = React.useState(false);

	React.useEffect(() => {
		setReport(null);
		setDryRunDone(false);
	}, [urlMap]);

	const run = async (apply: boolean) => {
		if (apply && !window.confirm(confirmText)) return;
		setRunning(apply ? "apply" : "dry");
		setError(undefined);
		const acc: ScanReport = { apply, scanned: 0, entries: [], leftovers: {}, videosAdded: 0, done: false };
		setReport(acc);
		try {
			let state: unknown = null;
			for (;;) {
				const page = await post<ScanPage>("scan", { apply, state, ...(urlMap ? { urlMap } : {}) }, "The scan failed");
				acc.scanned += page.scanned;
				acc.entries.push(...page.entries);
				acc.videosAdded += page.videosAdded;
				for (const [k, v] of Object.entries(page.leftovers)) acc.leftovers[k] = (acc.leftovers[k] ?? 0) + v;
				setProgress(`${page.progress}: ${acc.scanned.toLocaleString()} entries checked`);
				setReport({ ...acc, entries: [...acc.entries] });
				if (page.done) break;
				state = page.state;
			}
			acc.done = true;
			setReport({ ...acc, entries: [...acc.entries] });
			if (!apply) setDryRunDone(true);
		} catch (cause) {
			setError(errorText(cause, "The scan failed"));
		} finally {
			setRunning(false);
			setProgress("");
		}
	};

	const totals: Record<string, number> = {};
	for (const e of report?.entries ?? []) for (const [k, v] of Object.entries(e.changes)) totals[k] = (totals[k] ?? 0) + v;

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap gap-2">
				<Button variant="secondary" icon={<MagnifyingGlass />} disabled={Boolean(running)} onClick={() => void run(false)}>
					{running === "dry" ? "Checking…" : "Dry run"}
				</Button>
				<Button variant="primary" icon={<ArrowsClockwise />} disabled={Boolean(running) || !dryRunDone || !report?.entries.length} onClick={() => void run(true)}>
					{running === "apply" ? "Working…" : applyLabel}
				</Button>
				{running && <Loader size="sm" />}
			</div>
			<p className="sr-only" role="status" aria-live="polite">
				{progress}
			</p>
			{progress && <p className="text-sm text-kumo-subtle">{progress}</p>}
			{error && <Banner variant="error" role="alert" description={error} />}
			{report && (
				<div className="space-y-4">
					<p className="text-sm">
						{report.done ? (report.apply ? "Done. " : "Dry run finished. ") : ""}
						{report.entries.length.toLocaleString()} of {report.scanned.toLocaleString()} entries {report.apply ? "had" : "have"} something to change.
						{report.apply && report.videosAdded ? ` Added details for ${plural(report.videosAdded, "video", "videos")}.` : ""}
					</p>
					{Object.keys(totals).length > 0 && (
						<div>
							<h3 className="mb-1 text-sm font-medium">{report.apply ? "Changed" : "Would change"}</h3>
							<CountsTable counts={totals} label="Change" />
						</div>
					)}
					{Object.keys(report.leftovers).length > 0 && (
						<div>
							<h3 className="mb-1 text-sm font-medium">Kept as HTML blocks</h3>
							<p className="mb-1 text-xs text-kumo-subtle">
								No Coywolf Pack block for these (yet), or the block is turned off (notes, details, quotes, disclosures, testimonials and podcast links
								convert once their Custom Blocks switch is on: run this again). Their content is kept; “marker:gravity-form” is an empty placeholder
								for the theme. See the README.
							</p>
							<CountsTable counts={report.leftovers} />
						</div>
					)}
					{report.entries.length > 0 && (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-sm">
								<thead className="text-kumo-subtle">
									<tr>
										<th className="py-1 pe-3 font-medium">Entry</th>
										<th className="py-1 pe-3 font-medium">Status</th>
										<th className="py-1 pe-3 font-medium">Changes</th>
										{report.apply && <th className="py-1 font-medium">Result</th>}
									</tr>
								</thead>
								<tbody>
									{report.entries.slice(0, 1000).map((e) => (
										<tr key={`${e.collection}/${e.id}`} className="border-t border-kumo-line align-top">
											<td className="py-1 pe-3">
												<a className="text-kumo-link underline" href={`/_emdash/admin/content/${encodeURIComponent(e.collection)}/${encodeURIComponent(e.id)}`}>
													{e.title || e.id}
												</a>
												<span className="block text-xs text-kumo-subtle">{e.collection}</span>
											</td>
											<td className="py-1 pe-3">{e.status}</td>
											<td className="py-1 pe-3 text-xs">
												{Object.entries(e.changes)
													.map(([k, v]) => `${k} × ${v}`)
													.join(", ")}
											</td>
											{report.apply && (
												<td className="py-1 text-xs">
													{RESULT_LABEL[e.result ?? ""] ?? e.result ?? ""}
													{e.error ? `: ${e.error}` : ""}
												</td>
											)}
										</tr>
									))}
								</tbody>
							</table>
							{report.entries.length > 1000 && <p className="mt-1 text-xs text-kumo-subtle">Showing the first 1,000 entries.</p>}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function ConvertStep() {
	return (
		<Section
			title="2. Convert imported content"
			description="While WordPress import is on, entries are converted as they're imported or saved. This converts entries that are already on the site (imported earlier, or before the module or a block was on). Run a dry run first: it lists what would change and changes nothing."
		>
			<ScanPanel
				applyLabel="Convert"
				confirmText="Convert the blocks listed in the dry run? Each entry is saved (published entries are republished). Make a backup first."
			/>
		</Section>
	);
}

// ── 3. Co-authors and guest authors ──────────────────────────────

interface BylineSummary {
	id: string;
	slug: string;
	displayName: string;
	isGuest: boolean;
	avatarMediaId: string | null;
}

interface BylinePlan {
	byline: GuestByline;
	existing: BylineSummary | null;
	avatarMediaId: string | null;
	result?: string;
}

interface PostPlan {
	credit: PostCredit;
	entryId?: string;
	entryTitle?: string;
	/** Names of the bylines credited now. */
	current: string[];
	action: "credit" | "done" | "missing";
	result?: string;
}

/** Look up what's on the site for each author (an existing byline with that name, the avatar in the media library) and each post (its current bylines). */
async function planBylines(groups: GuestByline[], credits: PostCredit[]): Promise<{ bylines: BylinePlan[]; posts: PostPlan[] }> {
	const bylines: BylinePlan[] = [];
	for (const byline of groups) {
		const found = await getJson<{ items: BylineSummary[] }>(`${EMDASH}/admin/bylines?search=${encodeURIComponent(byline.name)}&limit=50`, "Could not list bylines");
		const matches = found.items.filter((b) => sameName(b.displayName, byline.name));
		const existing = matches.find((b) => b.isGuest) ?? matches[0] ?? null;
		let avatarMediaId: string | null = existing?.avatarMediaId ?? null;
		if (!avatarMediaId && byline.avatarFile) {
			const media = await getJson<{ items: Array<{ id: string; filename: string }> }>(
				`${EMDASH}/media?q=${encodeURIComponent(byline.avatarFile)}&limit=20`,
				"Could not search the media library",
			).catch(() => ({ items: [] }));
			avatarMediaId = media.items.find((m) => m.filename.toLowerCase() === byline.avatarFile.toLowerCase())?.id ?? null;
		}
		bylines.push({ byline, existing, avatarMediaId });
	}
	const idFor = (name: string) => bylines.find((b) => sameName(b.byline.name, name))?.existing?.id;
	const posts: PostPlan[] = [];
	for (const credit of credits) {
		try {
			const { item } = await getJson<{ item: { id: string; data?: Record<string, unknown>; bylines?: Array<{ byline: { id: string; displayName: string }; source?: string }> } }>(
				`${EMDASH}/content/${encodeURIComponent(credit.collection)}/${encodeURIComponent(credit.slug)}`,
				"Not found",
			);
			const explicit = (item.bylines ?? []).filter((c) => c.source !== "inferred").map((c) => c.byline.id);
			const wanted = credit.names.map(idFor);
			const done = wanted.every(Boolean) && wanted.length === explicit.length && wanted.every((id, i) => id === explicit[i]);
			posts.push({
				credit,
				entryId: item.id,
				entryTitle: typeof item.data?.title === "string" ? item.data.title : credit.title,
				current: (item.bylines ?? []).map((c) => c.byline.displayName),
				action: done ? "done" : "credit",
			});
		} catch {
			posts.push({ credit, current: [], action: "missing" });
		}
	}
	return { bylines, posts };
}

/** Create a guest byline, trying "-2", "-3", … if the slug is taken. */
async function createByline(plan: BylinePlan): Promise<BylineSummary> {
	const b = plan.byline;
	let lastError: unknown;
	for (let n = 1; n <= 5; n++) {
		try {
			return await send<BylineSummary>(
				`${EMDASH}/admin/bylines`,
				"POST",
				{ slug: n === 1 ? b.slug : `${b.slug}-${n}`, displayName: b.name, bio: b.bio || null, websiteUrl: b.url || null, avatarMediaId: plan.avatarMediaId, isGuest: true },
				"Could not create the byline",
			);
		} catch (error) {
			lastError = error;
			if (!/slug|exists|unique|conflict/i.test(String(error))) break;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Could not create the byline");
}

function BylinesStep({ wxr, onWxr }: { wxr: WxrInfo | null; onWxr: (info: WxrInfo) => void }) {
	const guests = wxr?.guests ?? null;
	const [plan, setPlan] = React.useState<{ bylines: BylinePlan[]; posts: PostPlan[] } | null>(null);
	const [running, setRunning] = React.useState<false | "dry" | "apply">(false);
	const [applied, setApplied] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const groups = React.useMemo(() => (guests ? groupGuests(guests) : []), [guests]);
	const credits = React.useMemo(() => (guests ? postCredits(guests) : []), [guests]);

	React.useEffect(() => {
		setPlan(null);
		setApplied(false);
	}, [guests]);

	const dryRun = async () => {
		setRunning("dry");
		setError(undefined);
		setApplied(false);
		try {
			setPlan(await planBylines(groups, credits));
		} catch (cause) {
			setError(errorText(cause, "The dry run failed"));
		} finally {
			setRunning(false);
		}
	};

	const apply = async () => {
		if (!plan) return;
		if (!window.confirm("Create the bylines and credit the posts listed? Each post's current bylines are replaced by its authors, in order.")) return;
		setRunning("apply");
		setError(undefined);
		const bylines = plan.bylines.map((b) => ({ ...b }));
		const posts = plan.posts.map((p) => ({ ...p }));
		const needed = new Set(posts.filter((p) => p.action === "credit").flatMap((p) => p.credit.names.map((n) => n.toLowerCase())));
		for (const b of bylines) {
			if (b.existing || !needed.has(b.byline.name.toLowerCase())) continue;
			try {
				b.existing = await createByline(b);
				b.result = `Created byline “${b.existing.displayName}” (${b.existing.slug})`;
			} catch (cause) {
				b.result = `Could not create the byline: ${errorText(cause, "unknown error")}`;
			}
			setPlan({ bylines: bylines.map((x) => ({ ...x })), posts });
		}
		const idFor = (name: string) => bylines.find((b) => sameName(b.byline.name, name))?.existing?.id;
		for (const p of posts) {
			if (p.action !== "credit" || !p.entryId) continue;
			const ids = p.credit.names.map(idFor);
			if (!ids.every(Boolean)) {
				p.result = "Skipped: a byline couldn't be created";
				continue;
			}
			try {
				await send(`${EMDASH}/content/${encodeURIComponent(p.credit.collection)}/${encodeURIComponent(p.entryId)}`, "PUT", { bylines: ids.map((bylineId) => ({ bylineId })) }, "Could not update the entry");
				p.action = "done";
				p.result = "Credited";
			} catch (cause) {
				p.result = `Failed: ${errorText(cause, "unknown error")}`;
			}
			setPlan({ bylines, posts: posts.map((x) => ({ ...x })) });
		}
		setPlan({ bylines, posts });
		setApplied(true);
		setRunning(false);
	};

	const toCredit = plan?.posts.filter((p) => p.action === "credit").length ?? 0;
	const toCreate = plan?.bylines.filter((b) => !b.existing).length ?? 0;

	return (
		<Section
			title="3. Co-authors and guest authors"
			description={
				<>
					EmDash's importer credits each post to its WordPress user only. Posts with co-authors or guest authors (Co-Authors Plus, PublishPress
					Authors, or Coywolf Guest Author) get their authors back: this creates a guest byline for each author who has none (name, website, bio, and
					avatar when it's in the media library) and credits each post to its authors in order, so the byline and author schema name them. It uses
					EmDash's own byline and content API with your account, a dry run first. Running it again changes nothing.
				</>
			}
		>
			<div className="flex flex-wrap items-center gap-2">
				{wxr === null && <ChooseExport disabled={Boolean(running)} onXml={(xml) => onWxr(readWxr(xml))} />}
				<Button variant="secondary" icon={<MagnifyingGlass />} disabled={Boolean(running) || !credits.length} onClick={() => void dryRun()}>
					{running === "dry" ? "Checking…" : "Dry run"}
				</Button>
				<Button variant="primary" icon={<UserPlus />} disabled={Boolean(running) || !plan || applied || (!toCredit && !toCreate)} onClick={() => void apply()}>
					{running === "apply" ? "Crediting…" : "Create bylines and credit posts"}
				</Button>
				{running && <Loader size="sm" />}
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{guests !== null && (
				<p className="text-sm" role="status">
					{credits.length
						? `${plural(credits.length, "post has", "posts have")} co-authors or guest authors (${plural(groups.length, "author", "authors")}).`
						: "No co-authors or guest authors in this export."}
					{plan && !applied ? ` Dry run: ${plural(toCreate, "byline", "bylines")} to create, ${plural(toCredit, "post", "posts")} to credit.` : ""}
				</p>
			)}
			{plan && plan.bylines.length > 0 && (
				<ul className="space-y-1 text-sm">
					{plan.bylines.map((b) => (
						<li key={b.byline.slug}>
							<strong>{b.byline.name}</strong>
							<span className="text-xs text-kumo-subtle">
								{" "}
								· {b.existing ? "Byline exists" : "New guest byline"}
								{b.byline.url ? ` · ${b.byline.url}` : ""}
								{b.byline.avatarFile ? (b.avatarMediaId ? " · avatar found" : ` · avatar ${b.byline.avatarFile} not in the media library`) : ""}
							</span>
							{b.result && <span className="block text-xs">{b.result}</span>}
						</li>
					))}
				</ul>
			)}
			{plan && plan.posts.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-kumo-subtle">
							<tr>
								<th className="py-1 pe-3 font-medium">Post</th>
								<th className="py-1 pe-3 font-medium">Byline now</th>
								<th className="py-1 font-medium">{applied ? "Result" : "Will"}</th>
							</tr>
						</thead>
						<tbody>
							{plan.posts.map((p) => (
								<tr key={`${p.credit.collection}/${p.credit.slug}`} className="border-t border-kumo-line align-top">
									<td className="py-1 pe-3">
										{p.entryId ? (
											<a className="text-kumo-link underline" href={`/_emdash/admin/content/${encodeURIComponent(p.credit.collection)}/${encodeURIComponent(p.entryId)}`}>
												{p.entryTitle || p.credit.title || p.credit.slug}
											</a>
										) : (
											p.credit.title || p.credit.slug
										)}
									</td>
									<td className="py-1 pe-3 text-xs">{p.current.join(", ") || "—"}</td>
									<td className="py-1 text-xs">
										{p.result ??
											(p.action === "done"
												? "Already credited"
												: p.action === "missing"
													? `Not found: no ${p.credit.collection} entry with the slug “${p.credit.slug}”`
													: `Credit ${p.credit.names.join(", ")}`)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Section>
	);
}

// ── 4. Category and page parents ─────────────────────────────────

function ParentsStep({ wxr, onWxr }: { wxr: WxrInfo | null; onWxr: (info: WxrInfo) => void }) {
	const parents = wxr?.parents ?? null;
	const [plans, setPlans] = React.useState<ParentPlan[] | null>(null);
	const [running, setRunning] = React.useState<false | "dry" | "apply">(false);
	const [applied, setApplied] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const pageMap = React.useMemo(() => (parents ? parentsMap(parents.pages) : {}), [parents]);
	const withParent = React.useMemo(() => (parents ? parents.categories.filter((c) => c.parent && c.parent !== c.slug).length : 0), [parents]);

	React.useEffect(() => {
		setPlans(null);
		setApplied(false);
	}, [parents]);

	const dryRun = async () => {
		if (!parents) return;
		setRunning("dry");
		setError(undefined);
		setApplied(false);
		try {
			const { terms } = await getJson<{ terms: SiteTerm[] }>(`${EMDASH}/taxonomies/category/terms?includeCounts=false`, "Could not list the categories");
			setPlans(planCategoryParents(parents.categories, terms));
		} catch (cause) {
			setError(errorText(cause, "The dry run failed"));
		} finally {
			setRunning(false);
		}
	};

	const apply = async () => {
		if (!plans) return;
		if (!window.confirm("Set the parent of each category listed as “Set”? Category archive and post URLs that include parent categories change to match WordPress.")) return;
		setRunning("apply");
		setError(undefined);
		const next = plans.map((p) => ({ ...p }));
		for (const plan of next) {
			if (plan.action !== "set" || !plan.parentTermId) continue;
			try {
				await send(`${EMDASH}/taxonomies/category/terms/${encodeURIComponent(plan.slug)}`, "PUT", { parentId: plan.parentTermId }, "Could not update the category");
				plan.action = "done";
				plan.current = plan.parent;
				plan.result = "Parent set";
			} catch (cause) {
				plan.result = `Failed: ${errorText(cause, "unknown error")}`;
			}
			setPlans(next.map((p) => ({ ...p })));
		}
		setPlans(next);
		setApplied(true);
		setRunning(false);
	};

	const toSet = plans?.filter((p) => p.action === "set").length ?? 0;
	const pageCount = Object.keys(pageMap).length;

	return (
		<Section
			title="4. Category and page parents"
			description={
				<>
					EmDash's importer creates every category at the top level and drops page parents, so WordPress URLs with parent categories
					(<Code>/news/local/a-post/</Code>) or parent pages (<Code>/about/team/</Code>) are lost. This sets each category's parent the way WordPress had
					it, with EmDash's own taxonomy API and your account, a dry run first. Running it again changes nothing. EmDash pages have no parent, so page
					parents are listed as a <Code>pageParents</Code> option to paste into <Code>coywolfPlugin()</Code> (see the README, “Content URLs”).
				</>
			}
		>
			<div className="flex flex-wrap items-center gap-2">
				{wxr === null && <ChooseExport disabled={Boolean(running)} onXml={(xml) => onWxr(readWxr(xml))} />}
				<Button variant="secondary" icon={<MagnifyingGlass />} disabled={Boolean(running) || !withParent} onClick={() => void dryRun()}>
					{running === "dry" ? "Checking…" : "Dry run"}
				</Button>
				<Button variant="primary" icon={<TreeStructure />} disabled={Boolean(running) || !plans || applied || !toSet} onClick={() => void apply()}>
					{running === "apply" ? "Setting parents…" : "Set category parents"}
				</Button>
				{running && <Loader size="sm" />}
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{parents !== null && (
				<p className="text-sm" role="status">
					{withParent ? `${plural(withParent, "category has", "categories have")} a parent in WordPress.` : "No categories with a parent in this export."}
					{plans && !applied ? ` Dry run: ${toSet} to set.` : ""}
					{applied ? " Done." : ""}
				</p>
			)}
			{plans && plans.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-kumo-subtle">
							<tr>
								<th className="py-1 pe-3 font-medium">Category</th>
								<th className="py-1 pe-3 font-medium">Parent in WordPress</th>
								<th className="py-1 pe-3 font-medium">Parent now</th>
								<th className="py-1 font-medium">{applied ? "Result" : "Will"}</th>
							</tr>
						</thead>
						<tbody>
							{plans.map((p) => (
								<tr key={p.slug} className="border-t border-kumo-line align-top">
									<td className="py-1 pe-3">
										{p.name}
										<span className="block font-mono text-xs text-kumo-subtle">{p.slug}</span>
									</td>
									<td className="py-1 pe-3 font-mono text-xs">{p.parent}</td>
									<td className="py-1 pe-3 font-mono text-xs">{p.current || "—"}</td>
									<td className="py-1 text-xs">
										{p.result ?? (p.action === "done" ? "Already set" : p.action === "missing" ? (p.note ?? "Not found") : p.current ? `Change to ${p.parent}` : `Set to ${p.parent}`)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{parents !== null && (
				<div className="space-y-1">
					<h3 className="text-sm font-medium">Page parents</h3>
					{pageCount ? (
						<>
							<p className="text-xs text-kumo-subtle">
								{plural(pageCount, "page has", "pages have")} a parent page. Add this to <Code>coywolfPlugin()</Code> in astro.config.mjs and use{" "}
								<Code>{"{pagepath}"}</Code> in the pages URL pattern, e.g. <Code>{'urls: { pages: "/{pagepath}/" }'}</Code>:
							</p>
							<pre className="overflow-x-auto rounded bg-kumo-tint p-2 font-mono text-xs">{optionSnippet("pageParents", pageMap)}</pre>
						</>
					) : (
						<p className="text-xs text-kumo-subtle">No pages with a parent page in this export.</p>
					)}
				</div>
			)}
		</Section>
	);
}

// ── 5. Old-site media URLs ───────────────────────────────────────

interface RedirectRuleOut {
	source: string;
	target: string;
	type: number;
	isRegex: boolean;
	note?: string;
}

/** Add rules through the Redirects module's import route, 5,000 at a time. */
async function addRedirects(rules: RedirectRuleOut[]): Promise<number> {
	let added = 0;
	for (let i = 0; i < rules.length; i += 5000) {
		const r = await send<{ imported: number }>(
			"/_emdash/api/plugins/coywolf-pack/redirects/import",
			"POST",
			{ rules: rules.slice(i, i + 5000) },
			"Could not add the redirects (is the Redirects module on?)",
		);
		added += r.imported;
	}
	return added;
}

/** The file name at the end of a URL, decoded when it can be. */
function fileName(url: string): string {
	const last = url.split(/[?#]/)[0]?.split("/").pop() ?? "";
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}

const STATUS_LABEL: Record<SiteUrlPlan["status"], string> = { matched: "In the media library", missing: "Not in the media library", ambiguous: "Several files fit" };

function MediaUrlsStep({ wxr, onWxr }: { wxr: WxrInfo | null; onWxr: (info: WxrInfo) => void }) {
	const [hosts, setHosts] = React.useState("");
	const [found, setFound] = React.useState<Map<string, number> | null>(null);
	const [media, setMedia] = React.useState<MediaFile[] | null>(null);
	const [known, setKnown] = React.useState<Record<string, string>>({});
	const [running, setRunning] = React.useState<false | "find" | "import" | "redirects">(false);
	const [progress, setProgress] = React.useState("");
	const [message, setMessage] = React.useState("");
	const [error, setError] = React.useState<string>();

	React.useEffect(() => {
		if (wxr?.site.hosts.length) setHosts(wxr.site.hosts.join(", "));
	}, [wxr]);

	const hostList = React.useMemo(() => parseHosts(hosts), [hosts]);
	const plans = React.useMemo(() => {
		if (!found || !media) return null;
		const all = new Map(found);
		// Attachments not used in content still get a redirect (links from other sites, image search).
		for (const url of wxr?.attachmentUrls ?? []) if (!all.has(url)) all.set(url, 0);
		return planSiteUrls(all, media, wxr?.attachmentUrls ?? null, known);
	}, [found, media, known, wxr]);
	const urlMap = React.useMemo(() => (plans ? rewriteMap(plans.filter((p) => p.count > 0)) : null), [plans]);
	const counts = { matched: 0, missing: 0, ambiguous: 0 };
	for (const p of plans ?? []) counts[p.status]++;
	const missing = plans?.filter((p) => p.status === "missing") ?? [];
	const origin = wxr?.site.homeUrl || wxr?.site.siteUrl || (hostList[0] ? `https://${hostList[0]}` : "");

	const find = async () => {
		setRunning("find");
		setError(undefined);
		setMessage("");
		try {
			const urls = new Map<string, number>();
			let state: unknown = null;
			for (;;) {
				const page = await post<{ done: boolean; scanned: number; urls: Record<string, number>; state: unknown; progress: string }>(
					"urls",
					{ hosts: hostList, prefixes: wxr?.site.prefixes ?? [], state },
					"The search failed",
				);
				for (const [u, n] of Object.entries(page.urls)) urls.set(u, (urls.get(u) ?? 0) + n);
				setProgress(`${page.progress}: ${plural(urls.size, "URL", "URLs")} found`);
				if (page.done) break;
				state = page.state;
			}
			const files: MediaFile[] = [];
			let cursor: string | undefined;
			for (let n = 0; n < 500; n++) {
				const page = await getJson<{ items: MediaFile[]; nextCursor?: string | null }>(
					`${EMDASH}/media?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
					"Could not list the media library",
				);
				files.push(...page.items.map((m) => ({ id: m.id, filename: m.filename, url: m.url, storageKey: m.storageKey })));
				setProgress(`Reading the media library: ${plural(files.length, "file", "files")}`);
				if (!page.nextCursor) break;
				cursor = page.nextCursor;
			}
			setFound(urls);
			setMedia(files);
		} catch (cause) {
			setError(errorText(cause, "The search failed"));
		} finally {
			setRunning(false);
			setProgress("");
		}
	};

	const importMissing = async () => {
		if (!missing.length || !origin) return;
		if (!window.confirm(`Download ${plural(missing.length, "file", "files")} from the old site into the media library? The old site must still be online.`)) return;
		setRunning("import");
		setError(undefined);
		setMessage("");
		const next = { ...known };
		let imported = 0;
		const failed: string[] = [];
		try {
			const batch = missing.map((p, i) => ({ plan: p, id: i + 1, url: sourceUrl(p.url, origin) })).filter((x) => x.url);
			for (let i = 0; i < batch.length; i += 10) {
				const chunk = batch.slice(i, i + 10);
				const r = await send<{ imported: Array<{ originalUrl: string; newUrl: string }>; failed: Array<{ originalUrl: string; error: string }> }>(
					`${EMDASH}/import/wordpress/media`,
					"POST",
					{ stream: false, attachments: chunk.map((x) => ({ id: x.id, url: x.url, filename: fileName(x.url as string) })) },
					"The media import failed",
				);
				for (const ok of r.imported) {
					const item = chunk.find((x) => x.url === ok.originalUrl);
					if (item) {
						next[item.plan.path] = ok.newUrl;
						imported++;
					}
				}
				for (const bad of r.failed) failed.push(`${bad.originalUrl} (${bad.error})`);
				setProgress(`Imported ${imported} of ${batch.length}`);
				setKnown({ ...next });
			}
			setMessage(`Imported ${plural(imported, "file", "files")}.${failed.length ? ` ${failed.length} failed: ${failed.slice(0, 10).join("; ")}${failed.length > 10 ? "; …" : ""}` : ""}`);
		} catch (cause) {
			setError(errorText(cause, "The media import failed"));
		} finally {
			setKnown(next);
			setRunning(false);
			setProgress("");
		}
	};

	const redirects = plans ? uploadRedirects(plans) : [];
	const addMediaRedirects = async () => {
		setRunning("redirects");
		setError(undefined);
		setMessage("");
		try {
			const added = await addRedirects(redirects);
			setMessage(`Added or updated ${plural(added, "redirect", "redirects")}.`);
		} catch (cause) {
			setError(errorText(cause, "Could not add the redirects"));
		} finally {
			setRunning(false);
		}
	};

	const shown = (plans ?? []).filter((p) => p.status !== "matched" || p.count > 0);

	return (
		<Section
			title="5. Old-site media URLs"
			description={
				<>
					EmDash's importer points image blocks at the media library, but URLs inside HTML blocks, links to files, other blocks' fields (like a
					testimonial photo or a video poster), size variants of large images (<Code>-1024x683</Code>, <Code>-scaled</Code>), files that were never in
					the media library, and theme or plugin files still point at the old site's <Code>/wp-content/</Code>. This finds them, matches each to a
					media library file (size variants to their original), downloads the missing ones from the old site with EmDash's media importer, rewrites
					content (a dry run first), and adds redirects from the old URLs.
				</>
			}
		>
			<div className="max-w-xl space-y-1">
				<Input label="Old site host names" placeholder="example.com, www.example.com" value={hosts} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHosts(e.target.value)} />
				<p className="text-xs text-kumo-subtle">
					Filled in from the export. Add any other host the site's media was served from (a CDN host name). Site-relative <Code>/wp-content/</Code>{" "}
					URLs are always found.
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{wxr === null && <ChooseExport disabled={Boolean(running)} onXml={(xml) => onWxr(readWxr(xml))} />}
				<Button variant="secondary" icon={<MagnifyingGlass />} disabled={Boolean(running)} onClick={() => void find()}>
					{running === "find" ? "Searching…" : "Find old URLs"}
				</Button>
				<Button variant="secondary" icon={<ImageSquare />} disabled={Boolean(running) || !missing.length || !origin} onClick={() => void importMissing()}>
					{running === "import" ? "Importing…" : `Import missing files${missing.length ? ` (${missing.length})` : ""}`}
				</Button>
				{running && <Loader size="sm" />}
			</div>
			<p className="sr-only" role="status" aria-live="polite">
				{progress}
			</p>
			{progress && <p className="text-sm text-kumo-subtle">{progress}</p>}
			{error && <Banner variant="error" role="alert" description={error} />}
			{message && (
				<p className="text-sm" role="status">
					{message}
				</p>
			)}
			{wxr === null && plans && (
				<p className="text-xs text-kumo-subtle">Without the export, uploads match by file name only, and unused attachments get no redirect.</p>
			)}
			{plans && (
				<div className="space-y-4">
					<p className="text-sm">
						{plural(found?.size ?? 0, "old URL", "old URLs")} in content. {counts.matched.toLocaleString()} in the media library, {counts.missing.toLocaleString()}{" "}
						not there yet, {counts.ambiguous.toLocaleString()} with several possible files (pick those in the editor).
					</p>
					{shown.length > 0 && (
						<details>
							<summary className="cursor-pointer text-sm font-medium">URLs ({shown.length.toLocaleString()})</summary>
							<div className="mt-2 max-h-96 cw-overflow-auto">
								<table className="w-full text-left text-sm">
									<thead className="text-kumo-subtle">
										<tr>
											<th className="py-1 pe-3 font-medium">URL</th>
											<th className="py-1 pe-3 text-end font-medium">Uses</th>
											<th className="py-1 font-medium">Status</th>
										</tr>
									</thead>
									<tbody>
										{shown.slice(0, 2000).map((p) => (
											<tr key={p.url} className="border-t border-kumo-line align-top">
												<td className="py-1 pe-3 font-mono text-xs break-all">{p.url}</td>
												<td className="py-1 pe-3 text-end tabular-nums">{p.count}</td>
												<td className="py-1 text-xs">
													{STATUS_LABEL[p.status]}
													{p.note ? ` · ${p.note}` : ""}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</details>
					)}
					<div className="space-y-2">
						<h3 className="text-sm font-medium">Rewrite URLs in content</h3>
						<p className="text-xs text-kumo-subtle">
							{urlMap && Object.keys(urlMap).length
								? `Points ${plural(Object.keys(urlMap).length, "URL", "URLs")} at the media library, in every entry's content and text fields. It also converts anything step 2 would.`
								: "Nothing to rewrite yet: find old URLs (and import missing files) first."}
						</p>
						{urlMap && Object.keys(urlMap).length > 0 && (
							<ScanPanel
								urlMap={urlMap}
								applyLabel="Rewrite URLs"
								confirmText="Rewrite the old URLs listed in the dry run? Each entry is saved (published entries are republished). Make a backup first."
							/>
						)}
					</div>
					<div className="space-y-2">
						<h3 className="text-sm font-medium">Redirects from old media URLs</h3>
						<p className="text-xs text-kumo-subtle">
							{plural(redirects.length, "old file URL", "old file URLs")} (with the old site's paths) can redirect to their media library files, for
							links from other sites and image search. They're added to the Redirects module, which handles file paths.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button variant="secondary" icon={<ArrowsLeftRight />} disabled={Boolean(running) || !redirects.length} onClick={() => void addMediaRedirects()}>
								{running === "redirects" ? "Adding…" : "Add to Redirects"}
							</Button>
							<Button
								variant="secondary"
								icon={<DownloadSimple />}
								disabled={!redirects.length}
								onClick={() => saveFile(`${JSON.stringify(redirects, null, "\t")}\n`, "wordpress-media-redirects.json", "application/json")}
							>
								Download JSON
							</Button>
						</div>
					</div>
				</div>
			)}
		</Section>
	);
}

// ── 6. Redirects ─────────────────────────────────────────────────

const REDIRECT_SOURCES = [
	{
		key: "redirection",
		label: "Redirection plugin",
		command: 'wp db query "SELECT url, action_data, action_code, action_type, match_type, regex, status FROM wp_redirection_items"',
	},
	{ key: "rankMath", label: "Rank Math", command: 'wp db query "SELECT sources, url_to, header_code, status FROM wp_rank_math_redirections"' },
	{ key: "yoast", label: "Yoast SEO Premium (JSON)", command: "wp option get wpseo-premium-redirects-base --format=json" },
	{ key: "coywolfSeo", label: "Coywolf SEO", command: 'wp db query "SELECT source, target, type, is_regex FROM wp_coywolf_seo_redirects"' },
] as const;

type RedirectSourceKey = (typeof REDIRECT_SOURCES)[number]["key"];

function RedirectsStep({ wxr, onWxr }: { wxr: WxrInfo | null; onWxr: (info: WxrInfo) => void }) {
	const [fields, setFields] = React.useState<Record<RedirectSourceKey, string>>({ redirection: "", rankMath: "", yoast: "", coywolfSeo: "" });
	const [built, setBuilt] = React.useState<{ rules: WpRedirect[]; skipped: RedirectsResult["skipped"] } | null>(null);
	const [running, setRunning] = React.useState(false);
	const [message, setMessage] = React.useState("");
	const [error, setError] = React.useState<string>();

	React.useEffect(() => setBuilt(null), [wxr, fields]);

	const build = () => {
		setError(undefined);
		setMessage("");
		try {
			const hosts = wxr?.site.hosts ?? [];
			const rows = (key: RedirectSourceKey) => (fields[key].trim() ? parseFileRows(fields[key]) : []);
			const parts: RedirectsResult[] = [wxr?.oldSlugs ?? { rules: [], skipped: [] }];
			parts.push(redirectionRules(rows("redirection"), hosts));
			parts.push(rankMathRules(rows("rankMath"), hosts));
			if (fields.yoast.trim()) {
				let value: unknown;
				try {
					value = JSON.parse(fields.yoast);
				} catch {
					throw new Error("The Yoast redirects aren't valid JSON.");
				}
				parts.push(yoastRules(value, hosts));
			}
			parts.push(coywolfSeoRules(rows("coywolfSeo"), hosts));
			// Rules from the plugins win over old slugs (a person set them).
			setBuilt({ rules: mergeRedirects(...parts.slice(1).map((p) => p.rules), parts[0]?.rules ?? []), skipped: parts.flatMap((p) => p.skipped) });
		} catch (cause) {
			setError(errorText(cause, "Could not read the redirects"));
		}
	};

	const add = async () => {
		if (!built) return;
		setRunning(true);
		setError(undefined);
		try {
			const added = await addRedirects(built.rules);
			setMessage(`Added or updated ${plural(added, "redirect", "redirects")}.`);
		} catch (cause) {
			setError(errorText(cause, "Could not add the redirects"));
		} finally {
			setRunning(false);
		}
	};

	return (
		<Section
			title="6. Redirects from WordPress"
			description={
				<>
					WordPress redirects a post's old slugs by itself, and redirect plugins keep their rules in the database; none of it comes over in the export.
					This turns old slugs (from the export) and the rules of Redirection, Rank Math, Yoast SEO Premium or Coywolf SEO (paste the output of the
					command under each box, run on the WordPress server with WP-CLI; change <Code>wp_</Code> if your tables use another prefix) into Redirects
					module rules. Old-slug redirects point at the URLs WordPress used: if your EmDash URLs differ, fix them on the Redirects page.
				</>
			}
		>
			<div className="flex flex-wrap items-center gap-2">
				{wxr === null && <ChooseExport label="Choose export file (old slugs)" onXml={(xml) => onWxr(readWxr(xml))} />}
				{wxr !== null && <p className="text-sm">{plural(wxr.oldSlugs.rules.length, "old-slug redirect", "old-slug redirects")} in the export.</p>}
			</div>
			<div className="grid gap-4 lg:grid-cols-2">
				{REDIRECT_SOURCES.map((s) => (
					<div key={s.key} className="space-y-1">
						<InputArea
							label={s.label}
							rows={3}
							className="font-mono text-xs"
							value={fields[s.key]}
							onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFields((f) => ({ ...f, [s.key]: e.target.value }))}
						/>
						<p className="text-xs text-kumo-subtle">
							<Code>{s.command}</Code>
						</p>
					</div>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="secondary" icon={<MagnifyingGlass />} disabled={running} onClick={build}>
					Build rules
				</Button>
				<Button variant="primary" icon={<ArrowsLeftRight />} disabled={running || !built?.rules.length} onClick={() => void add()}>
					{running ? "Adding…" : "Add to Redirects"}
				</Button>
				<Button
					variant="secondary"
					icon={<DownloadSimple />}
					disabled={!built?.rules.length}
					onClick={() => built && saveFile(`${JSON.stringify(built.rules, null, "\t")}\n`, "wordpress-redirects.json", "application/json")}
				>
					Download JSON
				</Button>
				{running && <Loader size="sm" />}
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{message && (
				<p className="text-sm" role="status">
					{message}
				</p>
			)}
			{built && (
				<div className="space-y-3">
					<p className="text-sm" role="status">
						{plural(built.rules.length, "rule", "rules")} ready.{built.skipped.length ? ` ${plural(built.skipped.length, "rule was", "rules were")} skipped (listed below).` : ""}
					</p>
					{built.rules.length > 0 && (
						<div className="max-h-96 cw-overflow-auto">
							<table className="w-full text-left text-sm">
								<thead className="text-kumo-subtle">
									<tr>
										<th className="py-1 pe-3 font-medium">From</th>
										<th className="py-1 pe-3 font-medium">To</th>
										<th className="py-1 pe-3 font-medium">Type</th>
										<th className="py-1 font-medium">Source</th>
									</tr>
								</thead>
								<tbody>
									{built.rules.slice(0, 2000).map((r) => (
										<tr key={`${r.isRegex}:${r.source}`} className="border-t border-kumo-line align-top">
											<td className="py-1 pe-3 font-mono text-xs break-all">
												{r.source}
												{r.isRegex ? " (pattern)" : ""}
											</td>
											<td className="py-1 pe-3 font-mono text-xs break-all">{r.target || "—"}</td>
											<td className="py-1 pe-3 tabular-nums">{r.type}</td>
											<td className="py-1 text-xs">{r.note}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					{built.skipped.length > 0 && (
						<ul className="list-disc space-y-0.5 ps-5 text-xs text-kumo-subtle">
							{built.skipped.slice(0, 200).map((s, i) => (
								<li key={`${i}:${s.source}`}>
									<span className="font-mono">{s.source}</span>: {s.reason}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</Section>
	);
}

// ── Coywolf WordPress plugins ────────────────────────────────────

function DefaultsStep() {
	const [cvm, setCvm] = React.useState("");
	const [files, setFiles] = React.useState("");
	const [saved, setSaved] = React.useState<unknown>(null);
	const [error, setError] = React.useState<string>();
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		void apiFetch(`${API}/settings`)
			.then((r) => parseApiResponse<{ defaults: unknown }>(r, "Could not load the settings"))
			.then((d) => setSaved(d.defaults))
			.catch(() => setSaved(null));
	}, []);

	const save = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const parse = (text: string, label: string) => {
				if (!text.trim()) return undefined;
				try {
					return JSON.parse(text) as unknown;
				} catch {
					throw new Error(`The ${label} isn't valid JSON.`);
				}
			};
			const d = await post<{ defaults: unknown }>("settings/save", { cvm: parse(cvm, "Video Manager settings"), files: parse(files, "Coywolf Files settings") }, "Could not save");
			setSaved(d.defaults);
		} catch (cause) {
			setError(errorText(cause, "Could not save"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section
			title="A. Player and download card defaults (before importing)"
			description="Video Manager and Coywolf Files blocks that didn't set an option used the plugin's settings. Paste them before importing so converted blocks look the same. Without them, the plugins' own defaults are used."
		>
			<div className="grid gap-4 lg:grid-cols-2">
				<div className="space-y-1">
					<InputArea label="Video Manager settings (JSON)" rows={4} className="font-mono text-xs" value={cvm} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCvm(e.target.value)} />
					<p className="text-xs text-kumo-subtle">
						<Code>wp option get coywolf_cvm_settings --format=json</Code>
					</p>
				</div>
				<div className="space-y-1">
					<InputArea label="Coywolf Files settings (JSON)" rows={4} className="font-mono text-xs" value={files} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFiles(e.target.value)} />
					<p className="text-xs text-kumo-subtle">
						<Code>wp option get coywolf_files_settings --format=json</Code>
					</p>
				</div>
			</div>
			<div className="flex items-center gap-3">
				<Button variant="secondary" disabled={busy || (!cvm.trim() && !files.trim())} onClick={() => void save()}>
					Save defaults
				</Button>
				{saved !== null && <span className="text-xs text-kumo-subtle">Saved: {JSON.stringify(saved)}</span>}
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
		</Section>
	);
}

const FILES_QUERY = 'wp db query "SELECT file_id, object_key, filename, mime, size, downloads, created FROM wp_coywolf_files"';

function FilesStep() {
	const [text, setText] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [message, setMessage] = React.useState("");
	const [error, setError] = React.useState<string>();
	const submit = async () => {
		setBusy(true);
		setError(undefined);
		setMessage("");
		try {
			const r = await post<{ added: number; errors: Array<{ row: number; error: string }> }>("files", { text }, "Import failed");
			setMessage(`Added ${plural(r.added, "file", "files")}.${r.errors.length ? ` Skipped ${r.errors.length}: ${r.errors.map((e) => `row ${e.row} (${e.error})`).join("; ")}` : ""}`);
		} catch (cause) {
			setError(errorText(cause, "Import failed"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Section
			title="B. Coywolf Files downloads"
			description={
				<>
					Registers files uploaded with Coywolf Files so File download blocks and old download links keep working (they keep their WordPress ids; set
					the download URL base on Files → Settings to the old link base, e.g. <Code>coywolf-file</Code>). The files themselves must be in the bucket
					bound as <Code>FILES</Code> (or <Code>MEDIA</Code>) under the same keys. Paste the output of (change <Code>wp_</Code> if your tables use
					another prefix):
					<span className="mt-1 block">
						<Code>{FILES_QUERY}</Code>
					</span>
				</>
			}
		>
			<InputArea label="Coywolf Files records" rows={4} className="font-mono text-xs" value={text} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)} />
			<Button variant="secondary" icon={<UploadSimple />} disabled={busy || !text.trim()} onClick={() => void submit()}>
				Import file records
			</Button>
			{message && (
				<p className="text-sm" role="status">
					{message}
				</p>
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
		</Section>
	);
}

function VideosStep() {
	const [fields, setFields] = React.useState({ descriptions: "", posters: "", downloads: "" });
	const [busy, setBusy] = React.useState(false);
	const [message, setMessage] = React.useState("");
	const [error, setError] = React.useState<string>();
	const submit = async () => {
		setBusy(true);
		setError(undefined);
		setMessage("");
		try {
			const body: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(fields)) {
				if (!v.trim()) continue;
				try {
					body[k] = JSON.parse(v);
				} catch {
					throw new Error(`The ${k} aren't valid JSON.`);
				}
			}
			const r = await post<{ updated: number }>("videos", body, "Import failed");
			setMessage(`Updated ${plural(r.updated, "video", "videos")}.`);
		} catch (cause) {
			setError(errorText(cause, "Import failed"));
		} finally {
			setBusy(false);
		}
	};
	const area = (key: keyof typeof fields, label: string, option: string) => (
		<div className="space-y-1">
			<InputArea label={label} rows={3} className="font-mono text-xs" value={fields[key]} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFields((f) => ({ ...f, [key]: e.target.value }))} />
			<p className="text-xs text-kumo-subtle">
				<Code>{`wp option get ${option} --format=json`}</Code>
			</p>
		</div>
	);
	return (
		<Section
			title="C. Video Manager library"
			description="Per-video descriptions, poster frames or images, and MP4 download links set on Video Manager's Edit Video page. They're used in VideoObject schema and the video sitemap."
		>
			<div className="grid gap-4 lg:grid-cols-3">
				{area("descriptions", "Descriptions (JSON)", "coywolf_cvm_descriptions")}
				{area("posters", "Posters (JSON)", "coywolf_cvm_posters")}
				{area("downloads", "MP4 downloads (JSON)", "coywolf_cvm_downloads")}
			</div>
			<Button variant="secondary" icon={<UploadSimple />} disabled={busy || !Object.values(fields).some((v) => v.trim())} onClick={() => void submit()}>
				Import video details
			</Button>
			{message && (
				<p className="text-sm" role="status">
					{message}
				</p>
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
		</Section>
	);
}

export function WpImportPage() {
	const [wxr, setWxr] = React.useState<WxrInfo | null>(null);
	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-2 border-b border-kumo-line pb-4">
				<h1 className="flex min-h-9 items-center text-2xl font-semibold leading-tight">WordPress import</h1>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">
					Finish moving a WordPress site to EmDash. EmDash's own importer brings over posts, pages, categories, tags, authors and media; these steps
					keep what it drops or misses: heading ids, reusable blocks, Details blocks, co-authors and guest authors, category and page parents, old media
					URLs, and redirects. Work through them in order. The README has the full checklist.
				</p>
			</header>
			<BeforeImport />
			<PrepareStep onWxr={setWxr} />
			<ConvertStep />
			<BylinesStep wxr={wxr} onWxr={setWxr} />
			<ParentsStep wxr={wxr} onWxr={setWxr} />
			<MediaUrlsStep wxr={wxr} onWxr={setWxr} />
			<RedirectsStep wxr={wxr} onWxr={setWxr} />
			<div className="space-y-2 border-t border-kumo-line pt-6">
				<h2 className="text-lg font-semibold">Coywolf WordPress plugins</h2>
				<p className="text-sm text-kumo-subtle">
					Only for sites that used Coywolf's WordPress plugins (Video Manager, Coywolf Files, Coywolf SEO, Custom Blocks, Guest Author). Their blocks
					convert in steps 1 and 2 when Videos, Reviews, Custom Blocks (and each block), Headings &amp; TOC, File Downloads and Code Blocks are on.
				</p>
			</div>
			<DefaultsStep />
			<FilesStep />
			<VideosStep />
		</div>
	);
}

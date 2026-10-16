/**
 * Schema admin page: Site Details (publisher), page and article types per
 * collection, author profiles, per-entry overrides, robots / Open Graph
 * settings, and a JSON-LD preview.
 */
import { Badge, Banner, Button, Checkbox, Dialog, Input, Loader, Select, Switch, Tabs } from "@cloudflare/kumo";
import { ImageSquare, MagnifyingGlass, PencilSimple, Plus, Trash, TreeStructure } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { SaveBar, isDirty } from "./save-bar.js";

const API = "/_emdash/api/plugins/coywolf-pack/schema";

type RowValue = string | Record<string, string>;
interface Row {
	prop: string;
	value: RowValue;
	/** Person rows: only on the person's profile page (where they're the main subject). */
	profileOnly?: boolean;
}
interface PropertyInput {
	input?: string;
	fields?: Record<string, { label: string; input: string }>;
}
interface TypeChoice {
	pageType?: string;
	articleType?: string;
}
interface SiteDetails {
	publisherType: "organization" | "person";
	organizationType?: string | null;
	personBylineId?: string | null;
	orgRows: Row[];
}
interface Collection {
	slug: string;
	label: string;
	routable: boolean;
	dated: boolean;
}
interface Config {
	settings: Record<string, string | number | boolean>;
	site: SiteDetails;
	types: Record<string, TypeChoice>;
	collections: Collection[];
	features: Record<string, boolean>;
	catalog: {
		pageTypes: Array<[string, string]>;
		articleTypes: Array<[string, string]>;
		organization: string[];
		organizationTypes: Array<[string, string]>;
		person: string[];
		inputs: Record<string, PropertyInput>;
	};
	keys: { home: string; custom: string };
}
interface Byline {
	id: string;
	slug: string;
	displayName: string;
	bio: string | null;
	websiteUrl: string | null;
	locale: string;
	rows: Row[] | null;
}
interface Override extends TypeChoice {
	collection: string;
	entryId: string;
	title?: string;
	/** "byline:<id>" or "publisher". */
	mainSubject?: string;
	updatedAt?: string;
}
interface EntryHit {
	id: string;
	slug: string | null;
	status: string;
	title: string;
}

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

async function get<T>(path: string): Promise<T> {
	return parseApiResponse<T>(await apiFetch(`${API}/${path}`), "The request failed");
}
async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, "The request failed");
}

const INPUT_TYPES: Record<string, string> = { url: "url", image: "url", email: "email", tel: "tel", date: "date", number: "number" };

function Section(props: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="space-y-4 rounded-lg border border-kumo-line p-4">
			<div>
				<h2 className="text-base font-semibold">{props.title}</h2>
				{props.description && <p className="mt-1 text-sm text-kumo-subtle">{props.description}</p>}
			</div>
			{props.children}
		</section>
	);
}

/** The last save's result ("Saved."), hidden again once there are new unsaved changes. */
function SavedStatus(props: { status?: string; dirty: boolean }) {
	return (
		<p className="text-sm text-kumo-subtle" aria-live="polite">
			{props.dirty ? "" : props.status}
		</p>
	);
}

// ── Media picker ─────────────────────────────────────────────────

interface MediaItem {
	id: string;
	url: string;
	filename: string;
	alt: string | null;
	width: number | null;
	height: number | null;
}

function MediaDialog(props: { open: boolean; onClose: () => void; onPick: (item: MediaItem) => void }) {
	const [items, setItems] = React.useState<MediaItem[]>([]);
	const [cursor, setCursor] = React.useState<string>();
	const [hasMore, setHasMore] = React.useState(false);
	const [loading, setLoading] = React.useState(false);
	const [error, setError] = React.useState<string>();

	const load = React.useCallback(async (next?: string) => {
		setLoading(true);
		setError(undefined);
		try {
			const result = await post<{ items: MediaItem[]; cursor?: string; hasMore: boolean }>("media", { cursor: next });
			setItems((current) => (next ? [...current, ...result.items] : result.items));
			setCursor(result.cursor);
			setHasMore(result.hasMore);
		} catch (cause) {
			setError(errorText(cause, "Could not load media"));
		} finally {
			setLoading(false);
		}
	}, []);
	React.useEffect(() => {
		if (props.open) void load();
	}, [props.open, load]);

	return (
		<Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Choose an image</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">Images from the media library.</Dialog.Description>
				{error && <Banner className="mt-3" variant="error" role="alert" description={error} />}
				<ul className="mt-4 grid max-h-96 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
					{items.map((item) => (
						<li key={item.id}>
							<button
								type="button"
								className="block w-full overflow-hidden rounded border border-kumo-line text-start focus-visible:outline-2 focus-visible:outline-kumo-brand"
								onClick={() => props.onPick(item)}
							>
								<img src={item.url} alt={item.alt ?? ""} className="aspect-square w-full object-cover" loading="lazy" />
								<span className="block truncate px-1 py-0.5 text-xs">{item.filename}</span>
							</button>
						</li>
					))}
				</ul>
				{loading && (
					<div className="flex justify-center py-4">
						<Loader />
					</div>
				)}
				{!loading && !items.length && !error && <p className="py-6 text-center text-sm text-kumo-subtle">No images yet.</p>}
				<div className="mt-4 flex justify-end gap-2">
					{hasMore && (
						<Button variant="secondary" disabled={loading} onClick={() => void load(cursor)}>
							Load more
						</Button>
					)}
					<Button variant="secondary" onClick={props.onClose}>
						Cancel
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Property editor (the WordPress property picker) ──────────────

function PropertyEditor(props: {
	rows: Row[];
	onChange: (rows: Row[]) => void;
	properties: string[];
	inputs: Record<string, PropertyInput>;
	label: string;
	/** Show a "Profile page only" checkbox per row (Person rows). */
	profileOnly?: boolean;
}) {
	const [adding, setAdding] = React.useState(props.properties[0] ?? "");
	const [picking, setPicking] = React.useState<number | null>(null);
	const update = (index: number, value: RowValue) => props.onChange(props.rows.map((r, i) => (i === index ? { ...r, value } : r)));
	const setProfileOnly = (index: number, on: boolean) =>
		props.onChange(
			props.rows.map((r, i) => {
				if (i !== index) return r;
				const { profileOnly: _drop, ...rest } = r;
				return on ? { ...rest, profileOnly: true } : rest;
			}),
		);
	const remove = (index: number) => props.onChange(props.rows.filter((_, i) => i !== index));
	const add = () => {
		const meta = props.inputs[adding];
		props.onChange([...props.rows, { prop: adding, value: meta?.fields ? {} : "" }]);
	};

	return (
		<div className="space-y-3">
			{props.rows.length === 0 && <p className="text-sm text-kumo-subtle">No properties yet. Add one below.</p>}
			{props.rows.map((row, index) => {
				const meta = props.inputs[row.prop] ?? {};
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and repeatable.
					<div key={index} className="flex items-start gap-2 rounded border border-kumo-line p-2">
						<div className="w-40 shrink-0 pt-2 font-mono text-xs">{row.prop}</div>
						<div className="min-w-0 flex-1 space-y-2">
							{meta.fields ? (
								Object.entries(meta.fields).map(([sub, subMeta]) => (
									<Input
										key={sub}
										label={subMeta.label}
										type={INPUT_TYPES[subMeta.input] ?? "text"}
										value={(typeof row.value === "object" ? row.value[sub] : "") ?? ""}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											update(index, { ...(typeof row.value === "object" ? row.value : {}), [sub]: e.target.value })
										}
									/>
								))
							) : (
								<div className="flex items-end gap-2">
									<div className="flex-1">
										<Input
											aria-label={`${props.label} ${row.prop}`}
											type={INPUT_TYPES[meta.input ?? ""] ?? "text"}
											placeholder={meta.input === "url" || meta.input === "image" ? "https://…" : undefined}
											value={typeof row.value === "string" ? row.value : ""}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(index, e.target.value)}
										/>
									</div>
									{meta.input === "image" && (
										<Button variant="secondary" icon={<ImageSquare aria-hidden="true" />} onClick={() => setPicking(index)}>
											Media
										</Button>
									)}
								</div>
							)}
							{props.profileOnly && row.prop !== "@id" && (
								<Checkbox
									label="Profile page only"
									checked={!!row.profileOnly}
									onCheckedChange={(checked: boolean) => setProfileOnly(index, checked)}
								/>
							)}
						</div>
						<Button
							variant="ghost"
							shape="square"
							icon={<Trash aria-hidden="true" />}
							aria-label={`Remove ${row.prop}`}
							onClick={() => remove(index)}
						/>
					</div>
				);
			})}
			<div className="flex items-end gap-2">
				<div className="w-64">
					<Select
						label="Add a property"
						value={adding}
						onValueChange={(value: string | null) => setAdding(value ?? "")}
						items={props.properties.map((p) => ({ value: p, label: p }))}
					/>
				</div>
				<Button variant="secondary" icon={<Plus aria-hidden="true" />} disabled={!adding} onClick={add}>
					Add
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle">
				Add a property more than once (sameAs, for example) to list several values. logo and image become ImageObjects with
				their dimensions.
			</p>
			<MediaDialog
				open={picking !== null}
				onClose={() => setPicking(null)}
				onPick={(item) => {
					if (picking !== null) update(picking, item.url);
					setPicking(null);
				}}
			/>
		</div>
	);
}

// ── Site details ─────────────────────────────────────────────────

function SiteTab(props: { config: Config; bylines: Byline[] | undefined; onSaved: (site: SiteDetails) => void }) {
	const [site, setSite] = React.useState<SiteDetails>(props.config.site);
	const [pending, setPending] = React.useState(false);
	const [status, setStatus] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const dirty = isDirty(site, props.config.site);

	const save = async () => {
		setPending(true);
		setError(undefined);
		try {
			const result = await post<{ site: SiteDetails }>("site/save", site);
			setSite(result.site);
			props.onSaved(result.site);
			setStatus("Saved.");
		} catch (cause) {
			setError(errorText(cause, "Could not save Site Details"));
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="space-y-6">
			<Section
				title="Publisher"
				description="Who publishes this site. It's the publisher of every article and the subject of the home page in the graph."
			>
				<Select
					label="Publisher type"
					value={site.publisherType}
					onValueChange={(value: string | null) => setSite({ ...site, publisherType: value === "person" ? "person" : "organization" })}
					items={[
						{ value: "organization", label: "Organization" },
						{ value: "person", label: "Person" },
					]}
				/>
				{site.publisherType === "organization" ? (
					<>
					<Select
						label="Organization type"
						value={site.organizationType || "Organization"}
						onValueChange={(value: string | null) => setSite({ ...site, organizationType: value || "Organization" })}
						items={props.config.catalog.organizationTypes.map(([value, label]) => ({ value, label }))}
					/>
					<PropertyEditor
						label="Organization"
						rows={site.orgRows}
						onChange={(orgRows) => setSite({ ...site, orgRows })}
						properties={props.config.catalog.organization}
						inputs={props.config.catalog.inputs}
					/>
					</>
				) : (
					<div className="space-y-2">
						{props.bylines === undefined ? (
							<Loader />
						) : props.bylines.length === 0 ? (
							<p className="text-sm text-kumo-subtle">Create a byline first (Content → Bylines).</p>
						) : (
							<Select
								label="Person (byline)"
								value={site.personBylineId ?? ""}
								onValueChange={(value: string | null) => setSite({ ...site, personBylineId: value || null })}
								items={[{ value: "", label: "Choose a byline" }, ...props.bylines.map((b) => ({ value: b.id, label: `${b.displayName} (${b.locale})` }))]}
							/>
						)}
						<p className="text-sm text-kumo-subtle">The person's properties come from the Authors tab.</p>
					</div>
				)}
				<p className="text-sm text-kumo-subtle">
					Without a name, url or logo, the site title, site URL and site logo from EmDash's settings are used.
				</p>
				{error && <Banner variant="error" role="alert" description={error} />}
				<SavedStatus status={status} dirty={dirty} />
			</Section>
			<SaveBar dirty={dirty} saving={pending} onSave={() => void save()} onDiscard={() => setSite(props.config.site)} />
		</div>
	);
}

// ── Types ────────────────────────────────────────────────────────

function TypesTab(props: { config: Config; onSaved: (types: Record<string, TypeChoice>) => void }) {
	const { config } = props;
	const [types, setTypes] = React.useState(config.types);
	const [pending, setPending] = React.useState(false);
	const [status, setStatus] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const dirty = isDirty(types, config.types);
	const pageItems = [{ value: "", label: "Default (Web Page)" }, ...config.catalog.pageTypes.map(([value, label]) => ({ value, label }))];
	const articleItems = [
		{ value: "", label: "Default (Blog Posting on article pages)" },
		...config.catalog.articleTypes.map(([value, label]) => ({ value, label })),
	];
	const rows = [
		{ key: config.keys.home, label: "Home page", hint: "The site root" },
		{ key: config.keys.custom, label: "Other pages", hint: "Archives and pages that aren't a content entry" },
		...config.collections.map((c) => ({ key: c.slug, label: c.label, hint: c.slug })),
	];
	const set = (key: string, patch: TypeChoice) => setTypes((t) => ({ ...t, [key]: { ...t[key], ...patch } }));

	const save = async () => {
		setPending(true);
		setError(undefined);
		try {
			const result = await post<{ types: Record<string, TypeChoice> }>("types/save", { types });
			setTypes(result.types);
			props.onSaved(result.types);
			setStatus("Saved.");
		} catch (cause) {
			setError(errorText(cause, "Could not save types"));
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="space-y-6">
			<Section
				title="Page and article types"
				description="The WebPage subtype and Article subtype for each kind of page. Override them for single entries on the Overrides tab."
			>
				<div className="rounded-lg border">
					<div className="cw-md-flex items-center gap-4 border-b bg-kumo-tint/50 px-4 py-2 text-sm font-medium text-kumo-subtle">
						<div className="flex-1">Pages</div>
						<div className="cw-w-60">Page type</div>
						<div className="cw-w-60">Article type</div>
					</div>
					{rows.map((row) => (
						<div key={row.key} className="flex flex-col gap-2 border-b px-4 py-3 last:border-0 cw-md-row md:gap-4">
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium">{row.label}</div>
								<div className="truncate text-xs text-kumo-subtle">{row.hint}</div>
							</div>
							<div className="cw-md-w-60">
								<Select
									aria-label={`${row.label} page type`}
									className="w-full min-w-0"
									value={types[row.key]?.pageType ?? ""}
									onValueChange={(value: string | null) => set(row.key, { pageType: value || undefined })}
									items={pageItems}
								/>
							</div>
							<div className="cw-md-w-60">
								<Select
									aria-label={`${row.label} article type`}
									className="w-full min-w-0"
									value={types[row.key]?.articleType ?? ""}
									onValueChange={(value: string | null) => set(row.key, { articleType: value || undefined })}
									items={articleItems}
								/>
							</div>
						</div>
					))}
				</div>
				{error && <Banner variant="error" role="alert" description={error} />}
				<SavedStatus status={status} dirty={dirty} />
			</Section>
			<SaveBar dirty={dirty} saving={pending} onSave={() => void save()} onDiscard={() => setTypes(config.types)} />
		</div>
	);
}

// ── Authors ──────────────────────────────────────────────────────

function defaultRows(byline: Byline): Row[] {
	const rows: Row[] = [{ prop: "name", value: byline.displayName }];
	if (byline.websiteUrl) rows.push({ prop: "url", value: byline.websiteUrl });
	if (byline.bio?.trim()) rows.push({ prop: "description", value: byline.bio.trim() });
	rows.push({ prop: "jobTitle", value: "" }, { prop: "sameAs", value: "" });
	return rows;
}

function AuthorsTab(props: { config: Config; bylines: Byline[] | undefined; authorsOn: boolean; reload: () => void }) {
	const [selected, setSelected] = React.useState<string>();
	const [rows, setRows] = React.useState<Row[]>([]);
	// What the selected byline has saved, to tell when `rows` has unsaved changes.
	const [baseline, setBaseline] = React.useState<Row[]>([]);
	const [pending, setPending] = React.useState(false);
	const [status, setStatus] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const byline = props.bylines?.find((b) => b.id === selected);

	React.useEffect(() => {
		if (!selected && props.bylines?.length === 1) setSelected(props.bylines[0].id);
	}, [props.bylines, selected]);
	React.useEffect(() => {
		const initial = byline ? (byline.rows ?? defaultRows(byline)) : [];
		setRows(initial);
		setBaseline(initial);
		setStatus(undefined);
		setError(undefined);
	}, [byline]);

	const dirty = !!byline && isDirty(rows, baseline);

	const save = async () => {
		if (!byline) return;
		setPending(true);
		setError(undefined);
		try {
			const result = await post<{ rows: Row[] }>("authors/save", { bylineId: byline.id, rows });
			const next = result.rows.length ? result.rows : defaultRows(byline);
			setRows(next);
			setBaseline(next);
			setStatus("Saved.");
			props.reload();
		} catch (cause) {
			setError(errorText(cause, "Could not save the author"));
		} finally {
			setPending(false);
		}
	};

	if (props.bylines === undefined)
		return (
			<div className="flex justify-center py-12">
				<Loader />
			</div>
		);

	return (
		<div className="space-y-6">
			<Section
				title="Authors"
				description="Schema.org Person properties for each byline, used as the author of articles they're credited on (and as the publisher, if it's a person). Unsaved bylines use their name, website, bio and avatar."
			>
				{!props.authorsOn && (
					<Banner variant="default" role="status" description="Turn on Author profiles (Features → Schema & Social) to save and use these properties." />
				)}
				{props.bylines.length === 0 ? (
					<p className="text-sm text-kumo-subtle">No bylines yet.</p>
				) : (
					<Select
						label="Byline"
						value={selected ?? ""}
						onValueChange={(value: string | null) => setSelected(value || undefined)}
						items={[
							{ value: "", label: "Choose a byline" },
							...props.bylines.map((b) => ({ value: b.id, label: `${b.displayName} (${b.locale})${b.rows ? " ✓" : ""}` })),
						]}
					/>
				)}
				{byline && (
					<>
						<PropertyEditor
							label={byline.displayName}
							rows={rows}
							onChange={setRows}
							properties={props.config.catalog.person}
							inputs={props.config.catalog.inputs}
							profileOnly
						/>
						<p className="text-xs text-kumo-subtle">
							<strong>Profile page only</strong> properties (birthDate or email, for example) appear only on a page whose main subject is
							this person (set on the Overrides tab), not on every article they wrote.
						</p>
						{error && <Banner variant="error" role="alert" description={error} />}
						<div className="flex items-center justify-between gap-2">
							<Button variant="ghost" onClick={() => setRows(defaultRows(byline))}>
								Reset to byline details
							</Button>
							<SavedStatus status={status} dirty={dirty} />
						</div>
					</>
				)}
			</Section>
			<SaveBar
				dirty={dirty}
				saving={pending}
				canSave={props.authorsOn}
				detail={props.authorsOn ? undefined : "Turn on Author profiles to save"}
				onSave={() => void save()}
				onDiscard={() => setRows(baseline)}
			/>
		</div>
	);
}

// ── Entry picker (overrides and preview) ─────────────────────────

function EntryPicker(props: { collections: Collection[]; onPick: (collection: string, entry: EntryHit) => void }) {
	const [collection, setCollection] = React.useState(props.collections[0]?.slug ?? "");
	const [query, setQuery] = React.useState("");
	const [items, setItems] = React.useState<EntryHit[]>();
	const [loading, setLoading] = React.useState(false);
	const [error, setError] = React.useState<string>();

	const find = React.useCallback(async () => {
		if (!collection) return;
		setLoading(true);
		setError(undefined);
		try {
			setItems((await post<{ items: EntryHit[] }>("entries/find", { collection, query })).items);
		} catch (cause) {
			setError(errorText(cause, "Could not load entries"));
		} finally {
			setLoading(false);
		}
	}, [collection, query]);
	React.useEffect(() => {
		void find();
		// Reload when the collection changes; the query is submitted explicitly.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [collection]);

	return (
		<div className="space-y-3">
			<form
				className="flex flex-col gap-2 sm:flex-row sm:items-end"
				onSubmit={(e) => {
					e.preventDefault();
					void find();
				}}
			>
				<div className="sm:w-64">
					<Select
						label="Collection"
						value={collection}
						onValueChange={(value: string | null) => setCollection(value ?? "")}
						items={props.collections.map((c) => ({ value: c.slug, label: c.label }))}
					/>
				</div>
				<div className="flex-1">
					<Input label="Find" placeholder="Title or slug" value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />
				</div>
				<Button type="submit" variant="secondary" icon={<MagnifyingGlass aria-hidden="true" />}>
					Search
				</Button>
			</form>
			{error && <Banner variant="error" role="alert" description={error} />}
			<div aria-live="polite">
				{loading ? (
					<Loader />
				) : items && items.length === 0 ? (
					<p className="text-sm text-kumo-subtle">No entries match (searches the 100 most recently updated).</p>
				) : (
					<ul className="max-h-64 divide-y overflow-y-auto rounded border border-kumo-line">
						{items?.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-kumo-tint focus:bg-kumo-tint focus:outline-none"
									onClick={() => props.onPick(collection, item)}
								>
									<span className="min-w-0 flex-1 truncate">{item.title}</span>
									{item.status !== "published" && <Badge variant="outline">{item.status}</Badge>}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

// ── Overrides ────────────────────────────────────────────────────

/** The site publisher's name, for the main-subject picker. */
function publisherLabel(config: Config, bylines: Byline[] | undefined): string {
	const site = config.site;
	if (site.publisherType === "person") {
		const name = bylines?.find((b) => b.id === site.personBylineId)?.displayName;
		return name ? `Site publisher (${name})` : "Site publisher";
	}
	const name = site.orgRows.find((r) => r.prop === "name" && typeof r.value === "string" && r.value.trim())?.value;
	return typeof name === "string" ? `Site publisher (${name.trim()})` : "Site publisher (organization)";
}

/** Main-subject choices: the entry's own bylines first, then the publisher, then every other byline. */
function subjectItems(config: Config, bylines: Byline[] | undefined, credited: string[]): Array<{ value: string; label: string }> {
	const all = bylines ?? [];
	const label = (b: Byline) => (all.filter((o) => o.displayName === b.displayName).length > 1 ? `${b.displayName} (${b.locale})` : b.displayName);
	const own = credited.map((id) => all.find((b) => b.id === id)).filter((b): b is Byline => !!b);
	const others = all.filter((b) => !credited.includes(b.id));
	return [
		{ value: "", label: "None" },
		...own.map((b) => ({ value: `byline:${b.id}`, label: `${label(b)} (credited on this entry)` })),
		{ value: "publisher", label: publisherLabel(config, bylines) },
		...others.map((b) => ({ value: `byline:${b.id}`, label: label(b) })),
	];
}

function OverrideDialog(props: { config: Config; bylines: Byline[] | undefined; draft: Override | null; onClose: () => void; onSaved: () => void }) {
	const [draft, setDraft] = React.useState<Override | null>(props.draft);
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const [credited, setCredited] = React.useState<string[]>([]);
	React.useEffect(() => {
		setDraft(props.draft);
		setError(undefined);
	}, [props.draft]);
	const picking = draft !== null && !draft.entryId;
	const entryKey = draft?.entryId ? `${draft.collection}:${draft.entryId}` : "";
	React.useEffect(() => {
		setCredited([]);
		if (!draft?.entryId) return;
		let live = true;
		post<{ ids: string[] }>("entries/bylines", { collection: draft.collection, entryId: draft.entryId })
			.then((result) => live && setCredited(result.ids))
			.catch(() => {});
		return () => {
			live = false;
		};
		// Only when the entry changes, not on every edit of the draft.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [entryKey]);

	const save = async () => {
		if (!draft) return;
		setPending(true);
		setError(undefined);
		try {
			await post("entries/save", draft);
			props.onSaved();
		} catch (cause) {
			setError(errorText(cause, "Could not save the override"));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog.Root open={props.draft !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{picking ? "Choose an entry" : "Entry schema"}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					{picking ? "Pick the entry to override." : (draft?.title ?? draft?.entryId)}
				</Dialog.Description>
				<div className="mt-4 space-y-4">
					{picking ? (
						<EntryPicker
							collections={props.config.collections}
							onPick={(collection, entry) => setDraft({ collection, entryId: entry.id, title: entry.title, ...(props.config.types[collection] ?? {}) })}
						/>
					) : (
						draft && (
							<>
								<Select
									label="Page type"
									value={draft.pageType ?? ""}
									onValueChange={(value: string | null) => setDraft({ ...draft, pageType: value || undefined })}
									items={[{ value: "", label: "Collection default" }, ...props.config.catalog.pageTypes.map(([value, label]) => ({ value, label }))]}
								/>
								<Select
									label="Article type"
									value={draft.articleType ?? ""}
									onValueChange={(value: string | null) => setDraft({ ...draft, articleType: value || undefined })}
									items={[{ value: "", label: "Collection default" }, ...props.config.catalog.articleTypes.map(([value, label]) => ({ value, label }))]}
								/>
								<div className="space-y-1">
									<Select
										label="Main subject"
										value={draft.mainSubject ?? ""}
										onValueChange={(value: string | null) => setDraft({ ...draft, mainSubject: value || undefined })}
										items={subjectItems(props.config, props.bylines, credited)}
									/>
									<p className="text-xs text-kumo-subtle">
										What this page is about. For a profile page, pick the person; for About or Contact, pick the organization. It
										becomes the page's mainEntity, with the person's profile-page-only properties. Profile pages usually use the
										Profile page type and no Article.
									</p>
								</div>
							</>
						)
					)}
					{error && <Banner variant="error" role="alert" description={error} />}
					<div className="flex justify-end gap-2">
						<Button variant="secondary" disabled={pending} onClick={props.onClose}>
							Cancel
						</Button>
						{!picking && (
							<Button variant="primary" disabled={pending} onClick={() => void save()}>
								{pending ? "Saving…" : "Save override"}
							</Button>
						)}
					</div>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

function OverridesTab(props: { config: Config; bylines: Byline[] | undefined }) {
	const [items, setItems] = React.useState<Override[]>();
	const [error, setError] = React.useState<string>();
	const [editing, setEditing] = React.useState<Override | null>(null);
	const [notice, setNotice] = React.useState<string>();
	const labels = Object.fromEntries([...props.config.catalog.pageTypes, ...props.config.catalog.articleTypes]);
	const collectionLabel = (slug: string) => props.config.collections.find((c) => c.slug === slug)?.label ?? slug;
	const subjectLabel = (subject: string) =>
		subject === "publisher"
			? "About: site publisher"
			: `About: ${props.bylines?.find((b) => `byline:${b.id}` === subject)?.displayName ?? "a byline"}`;

	const load = React.useCallback(async () => {
		try {
			setItems((await get<{ items: Override[] }>("entries")).items);
		} catch (cause) {
			setError(errorText(cause, "Could not load overrides"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const remove = async (item: Override) => {
		if (!window.confirm(`Remove the override for ${item.title ?? item.entryId}?`)) return;
		try {
			await post("entries/delete", { collection: item.collection, entryId: item.entryId });
			setNotice("Override removed.");
			await load();
		} catch (cause) {
			setError(errorText(cause, "Could not remove the override"));
		}
	};

	return (
		<Section
			title="Per-entry overrides"
			description="Give a single entry a different page or article type than its collection, or say who or what it's about (its main subject)."
		>
			<div className="flex justify-end">
				<Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => setEditing({ collection: "", entryId: "" })}>
					New override
				</Button>
			</div>
			<div aria-live="polite">{notice && <Banner variant="default" role="status" title={notice} />}</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{!items && !error ? (
				<Loader />
			) : items && items.length === 0 ? (
				<p className="py-6 text-center text-sm text-kumo-subtle">No overrides. Every entry uses its collection's types.</p>
			) : (
				<div className="rounded-lg border">
					{items?.map((item) => (
						<div key={`${item.collection}:${item.entryId}`} className="flex items-center gap-4 border-b px-4 py-2 text-sm last:border-0">
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{item.title || item.entryId}</div>
								<div className="text-xs text-kumo-subtle">{collectionLabel(item.collection)}</div>
							</div>
							<div className="hidden gap-1 sm:flex">
								{item.pageType && <Badge variant="secondary">{labels[item.pageType] ?? item.pageType}</Badge>}
								{item.articleType && <Badge variant="outline">{labels[item.articleType] ?? item.articleType}</Badge>}
								{item.mainSubject && <Badge variant="outline">{subjectLabel(item.mainSubject)}</Badge>}
							</div>
							<Button
								variant="ghost"
								shape="square"
								icon={<PencilSimple aria-hidden="true" />}
								aria-label={`Edit override for ${item.title || item.entryId}`}
								onClick={() => setEditing(item)}
							/>
							<Button
								variant="ghost"
								shape="square"
								icon={<Trash aria-hidden="true" />}
								aria-label={`Remove override for ${item.title || item.entryId}`}
								onClick={() => void remove(item)}
							/>
						</div>
					))}
				</div>
			)}
			<OverrideDialog
				config={props.config}
				bylines={props.bylines}
				draft={editing}
				onClose={() => setEditing(null)}
				onSaved={() => {
					setEditing(null);
					setNotice("Override saved.");
					void load();
				}}
			/>
		</Section>
	);
}

// ── Settings (search, robots, Open Graph) ────────────────────────

/** A robots limit field: blank → -1 (no limit); a number stays a number; anything else is sent as typed for the server to reject. */
const limit = (value: unknown): number | string => {
	const text = String(value ?? "").trim();
	if (!text) return -1;
	const n = Number(text);
	return Number.isFinite(n) ? n : text;
};

function SettingsTab(props: { config: Config; onSaved: (settings: Config["settings"]) => void }) {
	const [values, setValues] = React.useState(props.config.settings);
	const [pending, setPending] = React.useState(false);
	const [status, setStatus] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const dirty = isDirty(values, props.config.settings);
	const str = (key: string) => String(values[key] ?? "");
	const set = (key: string, value: string | number | boolean) => setValues((v) => ({ ...v, [key]: value }));
	const text = (key: string, label: string, placeholder?: string, description?: string) => (
		<div>
			<Input label={label} placeholder={placeholder} value={str(key)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value)} />
			{description && <p className="mt-1 text-xs text-kumo-subtle">{description}</p>}
		</div>
	);

	const save = async () => {
		setPending(true);
		setError(undefined);
		try {
			const body = {
				...values,
				// Blank means no limit (-1), never 0 (which would forbid snippets/previews).
				schemaRobotsMaxSnippet: limit(values.schemaRobotsMaxSnippet),
				schemaRobotsMaxVideo: limit(values.schemaRobotsMaxVideo),
				schemaRobotsNofollow: !!values.schemaRobotsNofollow,
			};
			const result = await post<{ settings: Config["settings"] }>("settings/save", body);
			setValues(result.settings);
			props.onSaved(result.settings);
			setStatus("Saved.");
		} catch (cause) {
			setError(errorText(cause, "Could not save settings"));
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="space-y-6">
			<Section title="Graph">
				{text("schemaSearchUrl", "Search URL template", "/?s={search_term_string}", "Adds a SearchAction to the WebSite node. Leave empty if the site has no search.")}
				{text("schemaAuthorUrlPattern", "Author page URL", "/author/{slug}/", "Your site's author page URL with {slug} for the byline slug, e.g. /author/{slug}/. Used for an author's url and @id when the byline has no website. Leave empty if the site has no author pages.")}
				{text("schemaBreadcrumbHome", "Breadcrumb home label", "Home", "First crumb when breadcrumbs are derived from the URL.")}
			</Section>
			<Section title="Robots" description="Applies with Robots directives on. Entries marked No index stay noindex.">
				<Select
					label="max-image-preview"
					value={str("schemaRobotsMaxImage")}
					onValueChange={(value: string | null) => set("schemaRobotsMaxImage", value ?? "")}
					items={[
						{ value: "large", label: "Large" },
						{ value: "standard", label: "Standard" },
						{ value: "none", label: "None" },
						{ value: "", label: "Don't set" },
					]}
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					<Input
						label="max-snippet (characters; blank or -1 = no limit)"
						type="number"
						min={-1}
						value={str("schemaRobotsMaxSnippet")}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("schemaRobotsMaxSnippet", e.target.value)}
					/>
					<Input
						label="max-video-preview (seconds; blank or -1 = no limit)"
						type="number"
						min={-1}
						value={str("schemaRobotsMaxVideo")}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("schemaRobotsMaxVideo", e.target.value)}
					/>
				</div>
				<Switch
					label="nofollow on every page"
					checked={!!values.schemaRobotsNofollow}
					onCheckedChange={(checked: boolean) => set("schemaRobotsNofollow", checked)}
				/>
			</Section>
			<Section title="Open Graph">
				{text("schemaOgLocale", "og:locale", "en_US", "Leave empty to derive it from the site locale.")}
			</Section>
			{error && <Banner variant="error" role="alert" description={error} />}
			<SavedStatus status={status} dirty={dirty} />
			<SaveBar dirty={dirty} saving={pending} onSave={() => void save()} onDiscard={() => setValues(props.config.settings)} />
		</div>
	);
}

// ── Preview ──────────────────────────────────────────────────────

interface Contribution {
	kind: string;
	name?: string;
	property?: string;
	content?: string;
	id?: string;
	graph?: unknown;
}

function PreviewTab(props: { config: Config }) {
	const [target, setTarget] = React.useState<"home" | "entry">("home");
	const [result, setResult] = React.useState<{ page: { url: string; pageType: string }; contributions: Contribution[] }>();
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();

	const run = async (body: Record<string, unknown>) => {
		setPending(true);
		setError(undefined);
		try {
			setResult(await post("preview", body));
		} catch (cause) {
			setError(errorText(cause, "Preview failed"));
		} finally {
			setPending(false);
		}
	};

	const tags = result?.contributions.filter((c) => c.kind !== "jsonld") ?? [];
	const jsonld = result?.contributions.filter((c) => c.kind === "jsonld") ?? [];

	return (
		<Section
			title="Preview"
			description="What Schema & Social adds to a page's head with the current settings. Entries are previewed from their stored fields; the live page may pass the theme's own title, breadcrumbs or page type."
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="sm:w-64">
					<Select
						label="Page"
						value={target}
						onValueChange={(value: string | null) => setTarget(value === "entry" ? "entry" : "home")}
						items={[
							{ value: "home", label: "Home page" },
							{ value: "entry", label: "An entry" },
						]}
					/>
				</div>
				{target === "home" && (
					<Button variant="primary" disabled={pending} onClick={() => void run({ target: "home" })}>
						Preview
					</Button>
				)}
			</div>
			{target === "entry" && (
				<EntryPicker collections={props.config.collections} onPick={(collection, entry) => void run({ target: "entry", collection, entryId: entry.id })} />
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
			<div aria-live="polite" aria-busy={pending}>
				{pending && <Loader />}
				{result && !pending && (
					<div className="space-y-4">
						<p className="text-sm text-kumo-subtle">
							{result.page.url} · page type “{result.page.pageType}”
						</p>
						{result.contributions.length === 0 && <p className="text-sm">Nothing: every Schema & Social feature is off.</p>}
						{tags.length > 0 && (
							<pre className="overflow-x-auto rounded bg-kumo-tint p-3 text-xs">
								{tags
									.map((t) =>
										t.kind === "property" ? `<meta property="${t.property}" content="${t.content}">` : `<meta name="${t.name}" content="${t.content}">`,
									)
									.join("\n")}
							</pre>
						)}
						{jsonld.map((j) => (
							<div key={j.id ?? "jsonld"}>
								<h3 className="mb-1 text-sm font-medium">JSON-LD ({j.id === "primary" ? "replaces EmDash's" : j.id})</h3>
								<pre className="max-h-[28rem] cw-overflow-auto rounded bg-kumo-tint p-3 text-xs">{JSON.stringify(j.graph, null, 2)}</pre>
							</div>
						))}
						{jsonld.length > 0 && (
							<p className="text-xs text-kumo-subtle">
								Check the live page with Google's Rich Results Test or the Schema.org validator after publishing changes.
							</p>
						)}
					</div>
				)}
			</div>
		</Section>
	);
}

// ── Page ─────────────────────────────────────────────────────────

const FEATURE_LABELS: Record<string, string> = {
	"schema.graph": "Schema.org graph",
	"schema.breadcrumbs": "Breadcrumb schema",
	"schema.robots": "Robots directives",
	"schema.openGraph": "Open Graph extras",
	"schema.authors": "Author profiles",
};

/**
 * Kumo's Tabs has no panel part, so each tab gets our own id and points at the
 * one panel below, which is labeled by the selected tab (not the raw value).
 */
const SCHEMA_PANEL_ID = "cw-schema-panel";
const schemaTabId = (value: string) => `cw-schema-tab-${value}`;
const SCHEMA_TABS = [
	{ value: "site", label: "Site details" },
	{ value: "types", label: "Types" },
	{ value: "authors", label: "Authors" },
	{ value: "overrides", label: "Overrides" },
	{ value: "settings", label: "Robots & social" },
	{ value: "preview", label: "Preview" },
].map((t) => ({
	...t,
	render: (props: React.ComponentPropsWithRef<"button">) => <button {...props} id={schemaTabId(t.value)} aria-controls={SCHEMA_PANEL_ID} />,
}));

export function SchemaPage() {
	const [config, setConfig] = React.useState<Config>();
	const [bylines, setBylines] = React.useState<Byline[]>();
	const [authorsOn, setAuthorsOn] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const [tab, setTab] = React.useState("site");

	const loadAuthors = React.useCallback(async () => {
		try {
			const result = await get<{ items: Byline[]; authorsOn: boolean }>("authors");
			setBylines(result.items);
			setAuthorsOn(result.authorsOn);
		} catch (cause) {
			setError(errorText(cause, "Could not load bylines"));
		}
	}, []);

	React.useEffect(() => {
		(async () => {
			try {
				setConfig(await get<Config>("config"));
				void loadAuthors();
			} catch (cause) {
				setError(errorText(cause, "Could not load schema settings"));
			}
		})();
	}, [loadAuthors]);

	const off = config ? Object.entries(FEATURE_LABELS).filter(([id]) => !config.features[id]) : [];

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<h1 className="flex min-h-9 min-w-0 items-center gap-2 text-2xl font-semibold leading-tight">
					<TreeStructure aria-hidden="true" /> Schema
				</h1>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">
					Schema.org structured data, robots directives and Open Graph extras. The graph replaces EmDash's built-in JSON-LD and
					keeps everything it had: headline, description, image, dates, author and publisher.
				</p>
			</header>

			{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			{off.length > 0 && (
				<Banner
					variant="default"
					role="status"
					description={`Off on the Coywolf Pack page: ${off.map(([, label]) => label).join(", ")}. Settings here are kept but not used until they're on.`}
				/>
			)}

			{!config && !error ? (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			) : config ? (
				<>
					<Tabs value={tab} onValueChange={setTab} tabs={SCHEMA_TABS} />
					<div role="tabpanel" id={SCHEMA_PANEL_ID} aria-labelledby={schemaTabId(tab)}>
						{tab === "site" && <SiteTab config={config} bylines={bylines} onSaved={(site) => setConfig({ ...config, site })} />}
						{tab === "types" && <TypesTab config={config} onSaved={(types) => setConfig({ ...config, types })} />}
						{tab === "authors" && <AuthorsTab config={config} bylines={bylines} authorsOn={authorsOn} reload={() => void loadAuthors()} />}
						{tab === "overrides" && <OverridesTab config={config} bylines={bylines} />}
						{tab === "settings" && <SettingsTab config={config} onSaved={(settings) => setConfig({ ...config, settings })} />}
						{tab === "preview" && <PreviewTab config={config} />}
					</div>
				</>
			) : null}
		</div>
	);
}

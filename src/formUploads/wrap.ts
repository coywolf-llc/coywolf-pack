/**
 * Private form uploads: wraps the EmDash Forms plugin so files sent through
 * its forms go to a private R2 bucket instead of the public media library.
 *
 * The Forms plugin (@emdash-cms/plugin-forms) stores a submitted file with
 * `ctx.media.upload()` (src/handlers/submit.ts) and deletes it with
 * `ctx.media.delete()` when a submission, a form's submissions or expired
 * submissions are deleted. Its handlers are otherwise untouched: every route
 * and hook runs with a `ctx.media` whose upload() writes to the private
 * bucket (when the feature is on and the form is selected) and whose delete()
 * removes private files. Spam protection, validation, file type and size
 * checks, notifications, webhooks and the confirmation message are all still
 * the Forms plugin's own.
 *
 * The submission records the file as media id "coywolf-private:<id>". The
 * file's details live in the Forms plugin's KV (coywolf-private-upload:<id>),
 * which the Form uploads admin page lists. Downloads go through a
 * permission-checked plugin route that only answers admins, always as an
 * attachment with a type that can't render as a page.
 */
import { PluginRouteError, pluginResponse } from "emdash";
import { z } from "zod";

import { getManyBatched } from "../core/storage.js";
import { contentDisposition } from "../files/format.js";
import { parseInput, workerEnv } from "../shared.js";
import {
	CONFIG_KEY,
	ENTRY_PREFIX,
	MAX_FILE_BYTES,
	ROUTE_PREFIX,
	SWEEP_TASK,
	UPLOAD_ID,
	chunkRange,
	formSelected,
	matchField,
	newUploadId,
	normalizeConfig,
	objectKey,
	privateIdOf,
	privateMediaId,
	safeContentType,
	sanitizeFilename,
	submissionPreview,
	sweepDecision,
	uploadTypeAllowed,
	type FormUploadsConfig,
	type UploadEntry,
} from "./lib.js";

export const FEATURE = "formUploads";
const PACK_FEATURES_OPTION = "plugin:coywolf-pack:settings:features";
const SCHEDULED_KEY = "coywolf-private-uploads:scheduled";

/** Options passed through the Forms plugin descriptor by privateFormUploads(). */
export interface PrivateFormUploadsOptions {
	/** R2 binding of the private bucket. Default "FORM_UPLOADS". */
	bucket?: string;
	/** R2 binding of EmDash's media bucket, for moving earlier uploads. Default "MEDIA". */
	mediaBucket?: string;
	/** D1 binding of the site database. Default "DB". */
	database?: string;
}

export const WRAP_OPTION = "coywolfPrivateUploads";

// ── Loose shapes of what the Forms plugin hands us ───────────────

interface SubmissionFile {
	fieldName: string;
	filename: string;
	contentType: string;
	size: number;
	mediaId: string;
}
interface Submission {
	formId: string;
	data: Record<string, unknown>;
	files?: SubmissionFile[];
	status?: string;
	createdAt: string;
	[key: string]: unknown;
}
interface FormField {
	name: string;
	label?: string;
	type: string;
}
interface FormDefinition {
	name: string;
	slug: string;
	pages?: Array<{ fields?: FormField[] }>;
	[key: string]: unknown;
}
interface Collection<T> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	getMany(ids: string[]): Promise<Map<string, T>>;
	deleteMany(ids: string[]): Promise<number>;
	query(options?: Record<string, unknown>): Promise<{ items: Array<{ id: string; data: T }>; cursor?: string; hasMore?: boolean }>;
}
interface Media {
	upload?(filename: string, contentType: string, bytes: ArrayBuffer): Promise<{ mediaId: string; storageKey: string; url: string }>;
	delete?(id: string): Promise<boolean>;
	get?(id: string): Promise<{ id: string; filename: string; mimeType: string; size: number | null } | null>;
	[key: string]: unknown;
}
export interface FormsCtx {
	input?: unknown;
	media?: Media;
	kv: {
		get<T>(key: string): Promise<T | null>;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<boolean>;
		list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
	};
	storage: Record<string, unknown>;
	cron?: { schedule(name: string, opts: { schedule: string }): Promise<void> };
	log?: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
	[key: string]: unknown;
}

const formsOf = (ctx: FormsCtx) => ctx.storage.forms as Collection<FormDefinition>;
const submissionsOf = (ctx: FormsCtx) => ctx.storage.submissions as Collection<Submission>;
const fieldsOf = (form: FormDefinition) => (form.pages ?? []).flatMap((p) => p.fields ?? []);

/** Bindings and the feature switch, injectable for tests. */
export interface Deps {
	bucket(): Promise<R2Bucket | undefined>;
	mediaBucket(): Promise<R2Bucket | undefined>;
	database(): Promise<D1Database | undefined>;
	/** The "Private Form Uploads" switch on the Features page. */
	enabled(): Promise<boolean>;
}

export function defaultDeps(options: PrivateFormUploadsOptions = {}): Deps {
	const env = async () => {
		try {
			return await workerEnv();
		} catch {
			return {} as Record<string, unknown>;
		}
	};
	const database = async () => (await env())[options.database ?? "DB"] as D1Database | undefined;
	return {
		bucket: async () => (await env())[options.bucket ?? "FORM_UPLOADS"] as R2Bucket | undefined,
		mediaBucket: async () => (await env())[options.mediaBucket ?? "MEDIA"] as R2Bucket | undefined,
		database,
		enabled: async () => {
			try {
				const db = await database();
				if (!db) return false;
				const row = await db.prepare("SELECT value FROM options WHERE name = ?").bind(PACK_FEATURES_OPTION).first<{ value: string }>();
				const stored = row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : null;
				return stored?.[FEATURE] === true;
			} catch (error) {
				// Can't tell whether the switch is on: keep the file private rather than publish it.
				console.error("coywolf-pack: could not read the Private form uploads switch; keeping files private", error);
				return true;
			}
		},
	};
}

// ── The private media sink ───────────────────────────────────────

interface Decision {
	private: boolean;
	form?: { id: string; def: FormDefinition };
}

/** Per-request state: whether this request's uploads are private, and which ones were made. */
interface RequestState {
	decision?: Promise<Decision>;
	taken: Set<string>;
	uploaded: string[];
}

async function findForm(ctx: FormsCtx, idOrSlug: string): Promise<{ id: string; def: FormDefinition } | null> {
	const byId = await formsOf(ctx).get(idOrSlug);
	if (byId) return { id: idOrSlug, def: byId };
	const bySlug = await formsOf(ctx).query({ where: { slug: idOrSlug }, limit: 1 });
	const first = bySlug.items[0];
	return first ? { id: first.id, def: first.data } : null;
}

export async function readConfig(ctx: FormsCtx): Promise<FormUploadsConfig> {
	return normalizeConfig(await ctx.kv.get(CONFIG_KEY));
}

async function decide(ctx: FormsCtx, deps: Deps): Promise<Decision> {
	if (!(await deps.enabled())) return { private: false };
	const formId = (ctx.input as { formId?: unknown } | undefined)?.formId;
	// An upload outside a form submission (a future Forms feature): keep it private.
	if (typeof formId !== "string" || !formId) return { private: true };
	const form = await findForm(ctx, formId);
	if (!form) return { private: true };
	return { private: formSelected(await readConfig(ctx), { id: form.id, slug: form.def.slug }), form };
}

export async function deletePrivate(ctx: FormsCtx, deps: Deps, id: string): Promise<boolean> {
	const entry = await ctx.kv.get<UploadEntry>(`${ENTRY_PREFIX}${id}`);
	const bucket = await deps.bucket();
	if (bucket) await bucket.delete(entry?.key ?? objectKey(id));
	else if (entry) throw new Error("The private uploads bucket isn't bound, so the file can't be deleted.");
	await ctx.kv.delete(`${ENTRY_PREFIX}${id}`);
	return !!entry;
}

/** Store one file in the private bucket and index it. */
export async function storePrivate(
	ctx: FormsCtx,
	bucket: R2Bucket,
	file: { filename: string; contentType: string; bytes: Uint8Array },
	meta: { form?: { id: string; def: FormDefinition }; fieldName: string; submissionId?: string | null; source?: UploadEntry["source"] },
): Promise<UploadEntry> {
	if (file.bytes.byteLength > MAX_FILE_BYTES) throw PluginRouteError.badRequest(`File is too large. Maximum: ${MAX_FILE_BYTES / 1024 / 1024} MB`);
	const id = newUploadId();
	const key = objectKey(id);
	const filename = sanitizeFilename(file.filename);
	const field = meta.form ? fieldsOf(meta.form.def).find((f) => f.name === meta.fieldName) : undefined;
	const entry: UploadEntry = {
		id,
		key,
		formId: meta.form?.id ?? "",
		formSlug: meta.form?.def.slug ?? "",
		formName: meta.form?.def.name ?? "",
		fieldName: meta.fieldName,
		fieldLabel: field?.label ?? meta.fieldName,
		filename,
		contentType: String(file.contentType || "application/octet-stream").slice(0, 120),
		size: file.bytes.byteLength,
		uploadedAt: new Date().toISOString(),
		submissionId: meta.submissionId ?? null,
		...(meta.source ? { source: meta.source } : {}),
	};
	await bucket.put(key, file.bytes, {
		httpMetadata: { contentType: safeContentType(file.contentType), contentDisposition: contentDisposition(filename) },
		customMetadata: { formId: entry.formId, field: entry.fieldName, filename },
	});
	try {
		await ctx.kv.set(`${ENTRY_PREFIX}${id}`, entry);
	} catch (error) {
		await bucket.delete(key).catch(() => undefined);
		throw error;
	}
	return entry;
}

/** `ctx.media` for the Forms plugin's handlers: private upload and delete, everything else unchanged. */
export function privateMedia(ctx: FormsCtx, deps: Deps, state: RequestState): Media {
	const original = ctx.media;
	const upload = async (filename: string, contentType: string, bytes: ArrayBuffer) => {
		state.decision ??= decide(ctx, deps);
		const decision = await state.decision;
		if (!decision.private) {
			if (!original?.upload) throw PluginRouteError.internal("File uploads are not configured");
			return original.upload(filename, contentType, bytes);
		}
		const bucket = await deps.bucket();
		// Fail closed: with the feature on, a missing bucket never sends files to the public library.
		if (!bucket) throw PluginRouteError.internal("File uploads are not configured");
		if (!uploadTypeAllowed(contentType)) throw new PluginRouteError("UNSUPPORTED_MEDIA_TYPE", "File type not allowed", 415);
		const data = new Uint8Array(bytes);
		const files = (ctx.input as { files?: Record<string, { filename: string; bytes: { byteLength: number } }> } | undefined)?.files;
		const fieldName = matchField(files, filename, data.byteLength, state.taken);
		const entry = await storePrivate(ctx, bucket, { filename, contentType, bytes: data }, { form: decision.form, fieldName });
		state.uploaded.push(entry.id);
		return { mediaId: privateMediaId(entry.id), storageKey: entry.key, url: "" };
	};
	const del = async (mediaId: string) => {
		const id = privateIdOf(mediaId);
		if (id) return deletePrivate(ctx, deps, id);
		if (!original?.delete) return false;
		return original.delete(mediaId);
	};
	if (!original) return { upload, delete: del };
	return new Proxy(original, {
		get: (target, prop, receiver) => (prop === "upload" ? upload : prop === "delete" ? del : Reflect.get(target, prop, receiver)),
		has: (target, prop) => prop === "upload" || prop === "delete" || Reflect.has(target, prop),
	});
}

/** Record which submission the files of this request belong to. */
export async function linkUploads(ctx: FormsCtx, ids: string[]): Promise<number> {
	if (!ids.length) return 0;
	const entries = (await Promise.all(ids.map((id) => ctx.kv.get<UploadEntry>(`${ENTRY_PREFIX}${id}`)))).filter((e): e is UploadEntry => !!e);
	const wanted = new Set(ids.map(privateMediaId));
	const formIds = [...new Set(entries.map((e) => e.formId).filter(Boolean))];
	let linked = 0;
	for (const formId of formIds) {
		const recent = await submissionsOf(ctx).query({ where: { formId }, orderBy: { createdAt: "desc" }, limit: 25 });
		for (const item of recent.items) {
			for (const file of item.data.files ?? []) {
				if (!wanted.has(file.mediaId)) continue;
				const id = privateIdOf(file.mediaId)!;
				const entry = entries.find((e) => e.id === id);
				if (!entry || entry.submissionId === item.id) continue;
				entry.submissionId = item.id;
				await ctx.kv.set(`${ENTRY_PREFIX}${id}`, entry);
				linked++;
			}
		}
	}
	return linked;
}

// ── Admin routes (added to the Forms plugin) ─────────────────────

export async function listEntries(ctx: FormsCtx): Promise<UploadEntry[]> {
	const rows = await ctx.kv.list(ENTRY_PREFIX);
	return rows
		.map((row) => row.value as UploadEntry)
		.filter((e) => e && typeof e.id === "string" && UPLOAD_ID.test(e.id))
		.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

async function ensureSweepScheduled(ctx: FormsCtx, force = false) {
	if (!ctx.cron) return;
	if (!force && (await ctx.kv.get(SCHEDULED_KEY))) return;
	await ctx.cron.schedule(SWEEP_TASK, { schedule: "@daily" });
	await ctx.kv.set(SCHEDULED_KEY, new Date().toISOString());
}

/** Files of submissions still in the media library (from before the feature was on). */
async function* mediaLibraryFiles(ctx: FormsCtx, config: FormUploadsConfig) {
	const forms = new Map<string, FormDefinition>();
	let cursor: string | undefined;
	do {
		const page = await submissionsOf(ctx).query({ limit: 100, cursor });
		for (const item of page.items) {
			const files = (item.data.files ?? []).filter((f) => f.mediaId && !privateIdOf(f.mediaId));
			if (!files.length) continue;
			if (!forms.has(item.data.formId)) {
				const def = await formsOf(ctx).get(item.data.formId);
				if (def) forms.set(item.data.formId, def);
			}
			const def = forms.get(item.data.formId);
			if (def && !formSelected(config, { id: item.data.formId, slug: def.slug })) continue;
			yield { submissionId: item.id, submission: item.data, files, form: def ? { id: item.data.formId, def } : undefined };
		}
		cursor = page.hasMore === false ? undefined : page.cursor;
	} while (cursor);
}

async function countMediaLibraryFiles(ctx: FormsCtx, config: FormUploadsConfig): Promise<number> {
	let n = 0;
	for await (const item of mediaLibraryFiles(ctx, config)) n += item.files.length;
	return n;
}

/** Move up to `limit` earlier uploads from the media library into the private bucket. */
export async function migrateBatch(ctx: FormsCtx, deps: Deps, limit: number) {
	const bucket = await deps.bucket();
	const media = await deps.mediaBucket();
	const db = await deps.database();
	if (!bucket) throw PluginRouteError.badRequest("Add the FORM_UPLOADS R2 binding first.");
	if (!media || !db) throw PluginRouteError.badRequest("The media bucket (MEDIA) or database (DB) binding isn't available.");
	const original = ctx.media;
	const config = await readConfig(ctx);
	let moved = 0;
	const failed: Array<{ submissionId: string; filename: string; reason: string }> = [];
	for await (const item of mediaLibraryFiles(ctx, config)) {
		if (moved + failed.length >= limit) break;
		const files = [...(item.submission.files ?? [])];
		let changed = false;
		for (const [index, file] of files.entries()) {
			if (privateIdOf(file.mediaId) || moved + failed.length >= limit) continue;
			try {
				const row = await db.prepare("SELECT storage_key FROM media WHERE id = ?").bind(file.mediaId).first<{ storage_key: string }>();
				const object = row?.storage_key ? await media.get(row.storage_key) : null;
				if (!object) {
					failed.push({ submissionId: item.submissionId, filename: file.filename, reason: "Not in the media library any more" });
					continue;
				}
				const bytes = new Uint8Array(await object.arrayBuffer());
				const entry = await storePrivate(
					ctx,
					bucket,
					{ filename: file.filename, contentType: file.contentType, bytes },
					{ form: item.form, fieldName: file.fieldName, submissionId: item.submissionId, source: "media-library" },
				);
				files[index] = { ...file, mediaId: privateMediaId(entry.id) };
				changed = true;
				// Point the submission at the private copy before the public one goes.
				await submissionsOf(ctx).put(item.submissionId, { ...item.submission, files });
				if (original?.delete) await original.delete(file.mediaId);
				moved++;
			} catch (error) {
				failed.push({ submissionId: item.submissionId, filename: file.filename, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		if (changed) item.submission.files = files;
	}
	const remaining = await countMediaLibraryFiles(ctx, config);
	ctx.log?.info("Form uploads moved to the private bucket", { moved, failed: failed.length, remaining });
	return { moved, failed, remaining: Math.max(0, remaining - failed.length) };
}

/** Daily: apply the retention setting, and remove files whose submission is gone or never saved. */
export async function sweep(ctx: FormsCtx, deps: Deps, now = Date.now()) {
	const config = await readConfig(ctx);
	const entries = await listEntries(ctx);
	const linked = entries.filter((e) => e.submissionId).map((e) => e.submissionId!) as string[];
	const existing = await getManyBatched(submissionsOf(ctx) as never, linked);
	const counts = { retention: 0, orphan: 0, relinked: 0 };
	for (const entry of entries) {
		const decision = sweepDecision(entry, {
			now,
			retentionDays: config.retentionDays,
			submissionExists: entry.submissionId ? existing.has(entry.submissionId) : null,
		});
		if (decision === "keep") continue;
		if (decision === "relink" && (await linkUploads(ctx, [entry.id]))) {
			counts.relinked++;
			continue;
		}
		await deletePrivate(ctx, deps, entry.id);
		counts[decision === "retention" ? "retention" : "orphan"]++;
	}
	if (counts.retention || counts.orphan || counts.relinked) ctx.log?.info("Private form uploads tidied", counts);
	return counts;
}

function adminRoutes(deps: Deps) {
	const route = (def: Record<string, unknown>) => ({ permission: "plugins:manage", ...def });
	return {
		[`${ROUTE_PREFIX}status`]: route({
			methods: ["GET"],
			request: { body: "none" },
			handler: async (ctx: FormsCtx) => {
				const [bucket, mediaBucket, enabled, config] = await Promise.all([deps.bucket(), deps.mediaBucket(), deps.enabled(), readConfig(ctx)]);
				await ensureSweepScheduled(ctx).catch(() => undefined);
				const forms: Array<{ id: string; slug: string; name: string; fileFields: number }> = [];
				let cursor: string | undefined;
				do {
					const page = await formsOf(ctx).query({ limit: 100, cursor });
					for (const item of page.items) {
						forms.push({ id: item.id, slug: item.data.slug, name: item.data.name, fileFields: fieldsOf(item.data).filter((f) => f.type === "file").length });
					}
					cursor = page.hasMore === false ? undefined : page.cursor;
				} while (cursor);
				forms.sort((a, b) => a.name.localeCompare(b.name));
				return {
					wrapped: true,
					enabled,
					bucketBound: !!bucket,
					mediaBucketBound: !!mediaBucket,
					config,
					forms,
					mediaLibraryFiles: await countMediaLibraryFiles(ctx, config),
				};
			},
		}),

		[`${ROUTE_PREFIX}list`]: route({
			methods: ["GET"],
			request: { body: "none" },
			handler: async (ctx: FormsCtx) => {
				const entries = await listEntries(ctx);
				const submissions = await getManyBatched(submissionsOf(ctx) as never, entries.map((e) => e.submissionId).filter((id): id is string => !!id));
				return {
					items: entries.map((entry) => {
						const sub = entry.submissionId ? (submissions.get(entry.submissionId) as Submission | undefined) : undefined;
						return {
							...entry,
							submission: sub ? { id: entry.submissionId, createdAt: sub.createdAt, status: sub.status ?? "new", preview: submissionPreview(sub.data) } : null,
						};
					}),
				};
			},
		}),

		[`${ROUTE_PREFIX}settings`]: route({
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx: FormsCtx) => {
				const input = parseInput(
					z.object({
						scope: z.enum(["all", "selected"]),
						forms: z.array(z.string().min(1).max(200)).max(500),
						retentionDays: z.number().int().min(0).max(3650),
					}),
					ctx.input,
				);
				const config = normalizeConfig(input);
				await ctx.kv.set(CONFIG_KEY, config);
				await ensureSweepScheduled(ctx, true).catch((error) => ctx.log?.warn("Couldn't schedule the private uploads cleanup", { error: String(error) }));
				return config;
			},
		}),

		/** One chunk (4 MB) of a file; the admin page joins the chunks. Raw bytes, always an attachment. */
		[`${ROUTE_PREFIX}download`]: route({
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			handler: async (ctx: FormsCtx) => {
				const input = parseInput(z.object({ id: z.string().regex(UPLOAD_ID), part: z.coerce.number().int().min(0).max(100).default(0) }), ctx.input);
				const entry = await ctx.kv.get<UploadEntry>(`${ENTRY_PREFIX}${input.id}`);
				const bucket = await deps.bucket();
				if (!entry || !bucket) throw PluginRouteError.notFound("File not found");
				const head = await bucket.head(entry.key);
				if (!head) throw PluginRouteError.notFound("File not found");
				const range = chunkRange(head.size, input.part);
				if (!range) throw PluginRouteError.badRequest("No such part");
				const object = head.size === 0 ? null : await bucket.get(entry.key, { range: { offset: range.start, length: range.end - range.start + 1 } });
				const bytes = object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array();
				ctx.log?.info("Private form upload downloaded", { id: entry.id, part: input.part });
				return pluginResponse({
					status: 200,
					headers: {
						"Content-Type": safeContentType(entry.contentType),
						"Content-Disposition": contentDisposition(entry.filename),
						"Content-Range": `bytes ${range.start}-${Math.max(range.start, range.end)}/${head.size}`,
					},
					body: { kind: "bytes", value: bytes },
				});
			},
		}),

		[`${ROUTE_PREFIX}delete`]: route({
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx: FormsCtx) => {
				const input = parseInput(z.object({ id: z.string().regex(UPLOAD_ID) }), ctx.input);
				const deleted = await deletePrivate(ctx, deps, input.id);
				if (!deleted) throw PluginRouteError.notFound("File not found");
				ctx.log?.info("Private form upload deleted", { id: input.id });
				return { deleted: true };
			},
		}),

		[`${ROUTE_PREFIX}migrate`]: route({
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx: FormsCtx) => {
				const input = parseInput(z.object({ limit: z.number().int().min(1).max(50).default(20) }), ctx.input ?? {});
				if (!(await deps.enabled())) throw PluginRouteError.badRequest("Turn on Private Form Uploads first (Coywolf Pack → Features).");
				return migrateBatch(ctx, deps, input.limit);
			},
		}),
	};
}

// ── The wrapper ──────────────────────────────────────────────────

// any: EmDash's resolved plugin shape.
type Resolved = { routes?: Record<string, any>; hooks?: Record<string, any>; [key: string]: unknown };

function withMedia(ctx: FormsCtx, deps: Deps, state: RequestState): FormsCtx {
	return { ...ctx, media: privateMedia(ctx, deps, state) };
}

/**
 * The Forms plugin with private uploads: every route and hook gets the
 * private `ctx.media`, the daily tidy runs on its cron hook, and the admin
 * routes are added. Its id, storage, admin pages and capabilities are kept.
 */
export function wrapFormsPlugin<T extends Resolved>(plugin: T, deps: Deps): T {
	const routes: Record<string, unknown> = {};
	for (const [name, route] of Object.entries(plugin.routes ?? {})) {
		routes[name] = {
			...route,
			handler: async (ctx: FormsCtx) => {
				const state: RequestState = { taken: new Set(), uploaded: [] };
				const result = await route.handler(withMedia(ctx, deps, state));
				if (state.uploaded.length) {
					await linkUploads(ctx, state.uploaded).catch((error) => ctx.log?.warn("Couldn't link private uploads to their submission yet", { error: String(error) }));
				}
				return result;
			},
		};
	}
	Object.assign(routes, adminRoutes(deps));

	const hooks: Record<string, unknown> = {};
	for (const [name, hook] of Object.entries(plugin.hooks ?? {})) {
		hooks[name] = { ...hook, handler: (event: unknown, ctx: FormsCtx) => hook.handler(event, withMedia(ctx, deps, { taken: new Set(), uploaded: [] })) };
	}
	const cron = hooks.cron as { handler: (event: { name?: string }, ctx: FormsCtx) => Promise<unknown> } | undefined;
	const sweepOr = (next?: (event: { name?: string }, ctx: FormsCtx) => Promise<unknown>) => async (event: { name?: string }, ctx: FormsCtx) => {
		if (event?.name === SWEEP_TASK) return sweep(ctx, deps);
		return next?.(event, ctx);
	};
	hooks.cron = cron
		? // The tidy can take longer than a hook's default 5 seconds on a big backlog.
			{ ...cron, timeout: Math.max(Number((cron as { timeout?: number }).timeout) || 0, 30_000), handler: sweepOr(cron.handler) }
		: { handler: sweepOr(), priority: 100, timeout: 30_000, dependencies: [], errorPolicy: "continue", exclusive: false, pluginId: (plugin as { id?: string }).id };

	return { ...plugin, routes, hooks } as T;
}

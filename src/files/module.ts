/**
 * File Downloads: the admin side. Routes for the block's file picker, the
 * Files page (list, delete, rebuild the usage index), and direct-to-R2 large
 * uploads (start, upload a part through the site, complete, abort). Hooks keep an
 * index of which entries use which files.
 */
import type { PluginContext, StorageCollection } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, requireFeature } from "../core/features.js";
import { parseInput, workerEnv } from "../shared.js";
import { downloadPath, extensionOf, formatSize, isUploadId, newUploadId, safeFilename } from "./format.js";
import { MAX_THROUGH_SITE, type R2Config, S3Error, partSizeFor, r2Client } from "./s3.js";
import { uploadsBindingName } from "./serve.js";
import { COLLECTIONS, type UploadDoc, invalidateSiteCache, settingsFrom } from "./site.js";
import { entryTitle, fileIdsIn } from "./walker.js";

export interface FilesOptions {
	/** R2 binding of the media bucket. Default "MEDIA". */
	media?: string;
	/** R2 binding of the bucket large uploads go to (the bucket named in settings). Default: FILES when bound, else the media bucket. */
	uploads?: string;
}

export const FILES_FEATURE = "files";
export const LARGE_UPLOADS_FEATURE = "files.largeUploads";
export const COUNTS_FEATURE = "files.counts";

// Parts go through the site (6 MiB each, 10,000 at most): just under 60 GB.
const MAX_UPLOAD = MAX_THROUGH_SITE;
/** The Files → Settings ceiling for the largest upload, in GB (fits MAX_UPLOAD). */
const MAX_UPLOAD_GB_SETTING = 50;
const DEFAULT_MAX_UPLOAD_GB = 5;
/** A part's body: PART_SIZE (6 MiB) plus slack, under EmDash's 8 MiB plugin route cap. */
const PART_BODY_MAX = 7 * 1024 * 1024;
export const UPLOAD_ID_HEADER = "x-cw-upload-id";
export const PART_NUMBER_HEADER = "x-cw-part-number";
const DEFAULT_BASE = "download";
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
export const CLEANUP_TASK = "files-abort-stale-uploads";

/**
 * File Downloads settings, edited on the Files page → Settings. Only the R2
 * secret access key is in the plugin's settingsSchema (secrets only), so every
 * other read supplies its default here or in settingsFrom().
 */
const R2_KEYS = ["filesR2AccountId", "filesR2AccessKeyId", "filesR2SecretAccessKey", "filesR2Bucket"] as const;

const hexColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const filesSettingsInput = z.object({
	filesBase: z
		.string()
		.trim()
		.transform((v) => v.replace(/^\/+|\/+$/g, "").toLowerCase())
		.refine((v) => v === "" || (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) && !v.startsWith("_")), "The download URL base must be one path segment: letters, digits, - or _."),
	filesPublicBaseUrl: z
		.string()
		.trim()
		.max(500)
		.refine((v) => v === "" || /^https:\/\/[^\s"'<>]+$/i.test(v), "The public bucket or CDN URL must start with https://."),
	filesScheme: z.enum(["auto", "light", "dark"]),
	filesAccent: z
		.string()
		.trim()
		.refine((v) => v === "" || hexColor.test(v), "The accent color must be a hex color such as #007392."),
	filesMaxUploadGb: z.number().int().min(1, "The largest upload must be at least 1 GB.").max(MAX_UPLOAD_GB_SETTING, `The largest upload can be at most ${MAX_UPLOAD_GB_SETTING} GB.`),
	filesR2AccountId: z
		.string()
		.trim()
		.refine((v) => v === "" || /^[a-f0-9]{32}$/i.test(v), "The R2 account ID should be 32 hexadecimal characters."),
	filesR2AccessKeyId: z.string().trim().max(200),
	filesR2Bucket: z
		.string()
		.trim()
		.refine((v) => v === "" || /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v), "The R2 bucket name isn't valid."),
	/** Write-only: a new secret replaces the saved one; empty keeps it. */
	filesR2SecretAccessKey: z.string().trim().max(500).optional(),
	clearR2Secret: z.boolean().optional(),
});

/** Whether all four R2 credentials are saved (not whether they work). */
async function r2Configured(ctx: PluginContext): Promise<boolean> {
	const values = await Promise.all(R2_KEYS.map((key) => ctx.settings.get<string>(key).catch(() => null)));
	return values.every((v) => typeof v === "string" && v.trim() !== "");
}

interface UsageDoc {
	fileId: string;
	collection: string;
	entryId: string;
	entryKey: string;
	title: string;
}

interface CountDoc {
	downloads: number;
	lastDownload?: string;
}

export const filesStorage = {
	[COLLECTIONS.uploads]: { indexes: ["status", "uploadedAt"] },
	[COLLECTIONS.usage]: { indexes: ["fileId", "entryKey"] },
	[COLLECTIONS.counts]: { indexes: [] },
};

function col<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	return (ctx.storage as Record<string, StorageCollection<T>>)[name];
}

/** Every document in a collection matching `where` (paged; capped). */
async function queryAll<T>(c: StorageCollection<T>, where?: Record<string, string>, maxPages = 50): Promise<Array<{ id: string; data: T }>> {
	const out: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const result = await c.query({ where, limit: 100, cursor });
		out.push(...result.items);
		if (!result.hasMore || !result.cursor) break;
		cursor = result.cursor;
	}
	return out;
}

async function r2Config(ctx: PluginContext): Promise<R2Config> {
	const [accountId, accessKeyId, secretAccessKey, bucket] = await Promise.all([
		ctx.settings.get<string>("filesR2AccountId"),
		ctx.settings.get<string>("filesR2AccessKeyId"),
		ctx.settings.get<string>("filesR2SecretAccessKey"),
		ctx.settings.get<string>("filesR2Bucket"),
	]);
	if (!accountId || !accessKeyId || !secretAccessKey || !bucket)
		throw PluginRouteError.badRequest(
			"Large uploads aren't set up: add the R2 account ID, access key ID, secret access key and bucket name on the Files page → Settings.",
		);
	if (!/^[a-f0-9]{32}$/i.test(accountId.trim())) throw PluginRouteError.badRequest("The R2 account ID should be 32 hexadecimal characters.");
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket.trim())) throw PluginRouteError.badRequest("The R2 bucket name isn't valid.");
	return { accountId: accountId.trim(), accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), bucket: bucket.trim() };
}

async function client(ctx: PluginContext) {
	const config = await r2Config(ctx);
	if (!ctx.http) throw PluginRouteError.internal("File Downloads needs the network:request capability.");
	const http = ctx.http;
	return r2Client(config, (url, init) => http.fetch(url, init));
}

/** S3 errors become readable 400s; credentials never appear in messages. */
async function s3<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof S3Error) {
			const hint =
				error.status === 403
					? " Check the access key, secret and bucket permissions."
					: error.code === "NoSuchUpload"
						? " The upload expired or was already finished."
						: "";
			throw PluginRouteError.badRequest(`R2: ${error.message}.${hint}`);
		}
		throw error;
	}
}

// ── Usage index ──────────────────────────────────────────────────

const usageId = (fileId: string, collection: string, entryId: string) => `${fileId}|${collection}|${entryId}`;

/** Bring the usage rows for one entry in line with its content. */
export async function indexEntry(ctx: PluginContext, collection: string, content: Record<string, unknown>): Promise<void> {
	const entryId = String(content.id ?? "");
	if (!entryId) return;
	const usage = col<UsageDoc>(ctx, COLLECTIONS.usage);
	const entryKey = `${collection}:${entryId}`;
	const wanted = fileIdsIn(content);
	const existing = await queryAll(usage, { entryKey }, 5);
	const title = entryTitle(content);
	const keep = new Set(wanted.map((id) => usageId(id, collection, entryId)));
	const stale = existing.filter((row) => !keep.has(row.id)).map((row) => row.id);
	const current = new Map(existing.map((row) => [row.id, row.data]));
	const puts = wanted
		.map((fileId) => ({ id: usageId(fileId, collection, entryId), data: { fileId, collection, entryId, entryKey, title } }))
		.filter((row) => current.get(row.id)?.title !== title);
	if (stale.length) await usage.deleteMany(stale);
	if (puts.length) await usage.putMany(puts);
}

export async function unindexEntry(ctx: PluginContext, collection: string, entryId: string): Promise<void> {
	const usage = col<UsageDoc>(ctx, COLLECTIONS.usage);
	const rows = await queryAll(usage, { entryKey: `${collection}:${entryId}` }, 5);
	if (rows.length) await usage.deleteMany(rows.map((r) => r.id));
}

// ── Cleanup ──────────────────────────────────────────────────────

/** Abort multipart uploads that started more than a day ago and never finished, and drop their records. */
export async function abortStaleUploads(ctx: PluginContext): Promise<number> {
	const uploads = col<UploadDoc>(ctx, COLLECTIONS.uploads);
	const cutoff = Date.now() - STALE_UPLOAD_MS;
	const stale = (await queryAll(uploads, { status: "uploading" }, 10)).filter((row) => Date.parse(row.data.uploadedAt) < cutoff);
	if (!stale.length) return 0;
	let r2: Awaited<ReturnType<typeof client>> | null = null;
	try {
		r2 = await client(ctx);
	} catch (error) {
		ctx.log.warn("Stale uploads: R2 credentials missing; dropping records only (an R2 lifecycle rule cleans up the parts)", {
			error: String(error instanceof Error ? error.message : error),
		});
	}
	let removed = 0;
	for (const { id, data } of stale) {
		try {
			if (r2 && data.uploadId) await r2.abortMultipart(data.key, data.uploadId);
			await uploads.delete(id);
			removed++;
		} catch (error) {
			ctx.log.warn("Could not abort a stale upload", { id, error: String(error instanceof Error ? error.message : error) });
		}
	}
	ctx.log.info("Stale uploads aborted", { removed });
	return removed;
}

// ── Routes ───────────────────────────────────────────────────────

const idInput = z.object({ id: z.string().min(1).max(64) });

export function filesModule(options: FilesOptions) {
	async function uploadsBucket(): Promise<R2Bucket | undefined> {
		const env = await workerEnv();
		return env[uploadsBindingName(env, options)] as R2Bucket | undefined;
	}

	async function siteSettings(ctx: PluginContext) {
		const raw: Record<string, unknown> = {};
		for (const key of ["filesBase", "filesPublicBaseUrl", "filesScheme", "filesAccent"]) raw[key] = await ctx.settings.get(key);
		return settingsFrom(raw);
	}

	async function readFilesSettings(ctx: PluginContext) {
		const site = await siteSettings(ctx);
		const [accountId, accessKeyId, secretKey, bucket, maxGb] = await Promise.all([
			ctx.settings.get<string>("filesR2AccountId"),
			ctx.settings.get<string>("filesR2AccessKeyId"),
			ctx.settings.get<string>("filesR2SecretAccessKey").catch(() => null),
			ctx.settings.get<string>("filesR2Bucket"),
			ctx.settings.get<number>("filesMaxUploadGb"),
		]);
		return {
			filesBase: site.base,
			filesPublicBaseUrl: site.publicBaseUrl,
			filesScheme: site.scheme,
			filesAccent: site.accent,
			filesMaxUploadGb: typeof maxGb === "number" && Number.isFinite(maxGb) ? maxGb : DEFAULT_MAX_UPLOAD_GB,
			filesR2AccountId: accountId ?? "",
			filesR2AccessKeyId: accessKeyId ?? "",
			filesR2Bucket: bucket ?? "",
			r2SecretSet: typeof secretKey === "string" && secretKey.trim() !== "",
		};
	}

	async function getUpload(ctx: PluginContext, id: string): Promise<UploadDoc> {
		const doc = isUploadId(id) ? await col<UploadDoc>(ctx, COLLECTIONS.uploads).get(id) : null;
		if (!doc) throw PluginRouteError.notFound("That upload doesn't exist.");
		return doc;
	}

	const routes = {
		/** Options for the block's file picker (Block Kit select with optionsRoute). */
		"files/options": definePluginRoute({
			permission: "content:create",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, FILES_FEATURE);
				const items: Array<{ id: string; name: string }> = [];
				const uploads = await queryAll(col<UploadDoc>(ctx, COLLECTIONS.uploads), { status: "ready" }, 10);
				uploads.sort((a, b) => b.data.uploadedAt.localeCompare(a.data.uploadedAt));
				for (const { data } of uploads) items.push({ id: data.id, name: `${data.name} (${formatSize(data.size)}, large upload)` });
				if (ctx.media) {
					let cursor: string | undefined;
					for (let page = 0; page < 5; page++) {
						const result = await ctx.media.list({ limit: 100, cursor });
						for (const m of result.items) items.push({ id: m.id, name: `${m.filename}${m.size ? ` (${formatSize(m.size)})` : ""}` });
						if (!result.hasMore || !result.cursor) break;
						cursor = result.cursor;
					}
				}
				return { items };
			},
		}),

		/** Everything the Files page shows. */
		"files/list": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, FILES_FEATURE);
				const settings = await siteSettings(ctx);
				const uploads = await queryAll(col<UploadDoc>(ctx, COLLECTIONS.uploads));
				const usage = await queryAll(col<UsageDoc>(ctx, COLLECTIONS.usage));

				const usedIn = new Map<string, Array<{ collection: string; id: string; title: string }>>();
				for (const { data } of usage) {
					const list = usedIn.get(data.fileId) ?? [];
					list.push({ collection: data.collection, id: data.entryId, title: data.title });
					usedIn.set(data.fileId, list);
				}

				type Item = {
					id: string;
					source: "upload" | "media" | "missing";
					status: "ready" | "uploading";
					name: string;
					type: string;
					ext: string;
					size: number;
					uploadedAt: string | null;
					url: string | null;
				};
				const items: Item[] = [];
				const seen = new Set<string>();
				for (const { data } of uploads) {
					seen.add(data.id);
					items.push({
						id: data.id,
						source: "upload",
						status: data.status,
						name: data.name,
						type: data.type,
						ext: extensionOf(data.name),
						size: data.size,
						uploadedAt: data.uploadedAt,
						url: data.status === "ready" ? downloadPath(settings.base, data.id, data.name) : null,
					});
				}
				const mediaIds = [...usedIn.keys()].filter((id) => !seen.has(id)).slice(0, 300);
				for (const id of mediaIds) {
					const m = ctx.media && !isUploadId(id) ? await ctx.media.get(id) : null;
					items.push(
						m
							? {
									id,
									source: "media",
									status: "ready",
									name: m.filename,
									type: m.mimeType,
									ext: extensionOf(m.filename),
									size: m.size ?? 0,
									uploadedAt: m.createdAt,
									url: downloadPath(settings.base, id, m.filename),
								}
							: { id, source: "missing", status: "ready", name: "Missing file", type: "", ext: "", size: 0, uploadedAt: null, url: null },
					);
				}

				const counts = await col<CountDoc>(ctx, COLLECTIONS.counts).getMany(items.map((i) => i.id));
				const features = await ctxFeatures(ctx);
				return {
					items: items.map((item) => ({
						...item,
						downloads: counts.get(item.id)?.downloads ?? 0,
						lastDownload: counts.get(item.id)?.lastDownload ?? null,
						usedIn: usedIn.get(item.id) ?? [],
					})),
					base: settings.base,
					countsEnabled: features[COUNTS_FEATURE] ?? false,
					largeUploadsEnabled: features[LARGE_UPLOADS_FEATURE] ?? false,
					r2Configured: await r2Configured(ctx),
				};
			},
		},

		/** The Files page's Settings tab (the R2 secret is reported as set or not, never returned). */
		"files/settings": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, FILES_FEATURE);
				return readFilesSettings(ctx);
			},
		},

		"files/settings/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, FILES_FEATURE);
				const { filesR2SecretAccessKey, clearR2Secret, ...plain } = parseInput(filesSettingsInput, ctx.input);
				for (const [key, value] of Object.entries(plain)) await ctx.settings.set(key, key === "filesBase" && value === "" ? DEFAULT_BASE : value);
				if (clearR2Secret) await ctx.settings.delete("filesR2SecretAccessKey");
				else if (filesR2SecretAccessKey) await ctx.settings.set("filesR2SecretAccessKey", filesR2SecretAccessKey);
				invalidateSiteCache();
				ctx.log.info("File Downloads settings saved", { r2SecretChanged: Boolean(clearR2Secret || filesR2SecretAccessKey) });
				return readFilesSettings(ctx);
			},
		}),

		/** Delete a large upload (object and record). Media library files are deleted in the Media Library. */
		"files/delete": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, FILES_FEATURE);
				const { id } = parseInput(idInput, ctx.input);
				const doc = await getUpload(ctx, id);
				if (doc.status === "uploading" && doc.uploadId) {
					const r2 = await client(ctx);
					await s3(() => r2.abortMultipart(doc.key, doc.uploadId!));
				} else {
					const bucket = await uploadsBucket();
					if (bucket) await bucket.delete(doc.key);
					else {
						const r2 = await client(ctx);
						await s3(() => r2.deleteObject(doc.key));
					}
				}
				const usage = col<UsageDoc>(ctx, COLLECTIONS.usage);
				const rows = await queryAll(usage, { fileId: id }, 10);
				await col<UploadDoc>(ctx, COLLECTIONS.uploads).delete(id);
				await col<CountDoc>(ctx, COLLECTIONS.counts).delete(id);
				if (rows.length) await usage.deleteMany(rows.map((r) => r.id));
				invalidateSiteCache(id);
				ctx.log.info("File deleted", { id, key: doc.key });
				return { deleted: true, usedIn: rows.map((r) => ({ collection: r.data.collection, id: r.data.entryId, title: r.data.title })) };
			},
		}),

		/**
		 * Rebuild the usage index from all content, a few pages per call. Start
		 * with {} and send back `next` until `done`.
		 */
		"files/reindex": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, FILES_FEATURE);
				const input = parseInput(
					z.object({
						next: z.object({ collections: z.array(z.string().max(100)).max(200), index: z.number().int().min(0), cursor: z.string().max(2000).optional() }).optional(),
					}),
					ctx.input,
				);
				if (!ctx.content || !ctx.schema) throw PluginRouteError.internal("File Downloads needs the content:read and schema:read capabilities.");
				const usage = col<UsageDoc>(ctx, COLLECTIONS.usage);
				let step = input.next;
				if (!step) {
					for (let i = 0; i < 20; i++) {
						const page = await usage.query({ limit: 100 });
						if (!page.items.length) break;
						await usage.deleteMany(page.items.map((r) => r.id));
					}
					const collections = (await ctx.schema.listCollections()).map((c) => c.slug);
					step = { collections, index: 0 };
				}
				let scanned = 0;
				for (let pages = 0; pages < 4 && step.index < step.collections.length; pages++) {
					const collection = step.collections[step.index];
					const result = await ctx.content.list(collection, { limit: 50, cursor: step.cursor });
					const rows: Array<{ id: string; data: UsageDoc }> = [];
					for (const item of result.items) {
						scanned++;
						const record = { ...item } as unknown as Record<string, unknown>;
						const title = entryTitle(record);
						for (const fileId of fileIdsIn(item.data))
							rows.push({ id: usageId(fileId, collection, item.id), data: { fileId, collection, entryId: item.id, entryKey: `${collection}:${item.id}`, title } });
					}
					if (rows.length) await usage.putMany(rows);
					if (result.hasMore && result.cursor) step = { ...step, cursor: result.cursor };
					else step = { collections: step.collections, index: step.index + 1 };
				}
				const done = step.index >= step.collections.length;
				return { done, scanned, next: done ? undefined : step };
			},
		}),

		// ── Large uploads ──

		"files/upload-start": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, LARGE_UPLOADS_FEATURE);
				const input = parseInput(
					z.object({
						name: z.string().trim().min(1).max(255),
						size: z.number().int().positive().max(MAX_UPLOAD),
						type: z.string().max(255).optional(),
					}),
					ctx.input,
				);
				const maxGb = (await ctx.settings.get<number>("filesMaxUploadGb")) ?? DEFAULT_MAX_UPLOAD_GB;
				if (input.size > Math.min(maxGb, MAX_UPLOAD_GB_SETTING) * 1024 ** 3)
					throw PluginRouteError.badRequest(`That file is ${formatSize(input.size)}; the limit is ${maxGb} GB (Files → Settings).`);
				const r2 = await client(ctx);
				const id = newUploadId();
				const key = `files/${id}/${safeFilename(input.name)}`;
				const type = /^[\w.+-]+\/[\w.+-]+$/.test(input.type ?? "") ? input.type! : "application/octet-stream";
				const uploadId = await s3(() => r2.createMultipart(key, type));
				const partSize = partSizeFor(input.size);
				const doc: UploadDoc = {
					id,
					key,
					name: input.name.replace(/[\r\n\t\0]/g, " "),
					size: input.size,
					type,
					uploadedAt: new Date().toISOString(),
					status: "uploading",
					uploadId,
					partSize,
				};
				await col<UploadDoc>(ctx, COLLECTIONS.uploads).put(id, doc);
				return { id, partSize, partCount: Math.max(1, Math.ceil(input.size / partSize)) };
			},
		}),

		/**
		 * One part of a large upload, uploaded to R2 by the Worker. EmDash's admin
		 * Content-Security-Policy (connect-src 'self', since EmDash 1.3.1) blocks the browser
		 * from sending parts to R2 itself. The part goes to the multipart upload recorded by
		 * files/upload-start, and must be exactly the size that part should be.
		 */
		"files/upload-part": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "bytes", maxBytes: PART_BODY_MAX, headers: [UPLOAD_ID_HEADER, PART_NUMBER_HEADER] },
			handler: async (ctx) => {
				await requireFeature(ctx, LARGE_UPLOADS_FEATURE);
				const id = ctx.request.headers.get(UPLOAD_ID_HEADER) ?? "";
				const partNumber = Number(ctx.request.headers.get(PART_NUMBER_HEADER));
				const bytes = ctx.input as Uint8Array;
				if (!id || id.length > 64) throw PluginRouteError.badRequest("Unknown upload.");
				const doc = await getUpload(ctx, id);
				if (doc.status !== "uploading" || !doc.uploadId || !doc.partSize) throw PluginRouteError.conflict("That upload is already finished.");
				const partCount = Math.max(1, Math.ceil(doc.size / doc.partSize));
				if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) throw PluginRouteError.badRequest("Part number out of range.");
				const expected = partNumber < partCount ? doc.partSize : doc.size - (partCount - 1) * doc.partSize;
				if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected)
					throw PluginRouteError.badRequest(`Part ${partNumber} should be ${expected} bytes, not ${bytes instanceof Uint8Array ? bytes.byteLength : 0}.`);
				const r2 = await client(ctx);
				const etag = await s3(() => r2.uploadPart(doc.key, doc.uploadId!, partNumber, bytes));
				return { partNumber, etag };
			},
		}),

		"files/upload-complete": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 * 1024 },
			handler: async (ctx) => {
				await requireFeature(ctx, LARGE_UPLOADS_FEATURE);
				const input = parseInput(
					z.object({
						id: z.string().max(64),
						parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) })).min(1).max(10_000),
					}),
					ctx.input,
				);
				const doc = await getUpload(ctx, input.id);
				if (doc.status !== "uploading" || !doc.uploadId) throw PluginRouteError.conflict("That upload is already finished.");
				const r2 = await client(ctx);
				await s3(() => r2.completeMultipart(doc.key, doc.uploadId!, input.parts));
				const head = await s3(() => r2.headObject(doc.key));
				if (!head) throw PluginRouteError.badRequest("R2 didn't keep the uploaded file. Try again.");
				const ready: UploadDoc = { id: doc.id, key: doc.key, name: doc.name, size: head.size || doc.size, type: doc.type, uploadedAt: new Date().toISOString(), status: "ready" };
				await col<UploadDoc>(ctx, COLLECTIONS.uploads).put(doc.id, ready);
				invalidateSiteCache(doc.id);
				ctx.log.info("Large upload finished", { id: doc.id, size: ready.size });
				const settings = await siteSettings(ctx);
				return { ...ready, url: downloadPath(settings.base, ready.id, ready.name) };
			},
		}),

		"files/upload-abort": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, LARGE_UPLOADS_FEATURE);
				const { id } = parseInput(idInput, ctx.input);
				const doc = await getUpload(ctx, id);
				if (doc.status !== "uploading") throw PluginRouteError.conflict("That upload is already finished; delete it instead.");
				if (doc.uploadId) {
					const r2 = await client(ctx);
					await s3(() => r2.abortMultipart(doc.key, doc.uploadId!));
				}
				await col<UploadDoc>(ctx, COLLECTIONS.uploads).delete(id);
				return { aborted: true };
			},
		}),
	};

	return { routes };
}

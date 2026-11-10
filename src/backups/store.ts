/**
 * Backup storage layout (shared with .github/workflows/backup.yml):
 *
 *   d1/<stamp>/<file>.sql.gz   database dump
 *   d1/<stamp>/manifest.json   what the dump is and where it came from
 *   media/current/<key>        mirror of the media bucket
 *   media/changed/<stamp>/<key> media replaced or deleted since the previous run
 *   uploads/current/<key>      mirror of the private form uploads bucket (when bound)
 *   uploads/changed/<stamp>/<key> uploads replaced or deleted since the previous run
 *
 * The backup bucket must stay private: uploads/ holds files people sent
 * through forms, which aren't public on the site.
 */

export interface Manifest {
	stamp: string;
	database?: string;
	file: string;
	bytes: number;
	sha256: string;
	/** "github-actions" (external nightly job), "scheduled" (plugin), or "admin" (Back up now). */
	source?: string;
	timeTravelBookmark?: string;
	gitSha?: string;
	tables?: number;
	rows?: number;
	media?: MirrorResult;
	/** Private form uploads, when the site has an uploads bucket. */
	uploads?: MirrorResult;
}

export interface MirrorResult {
	copied: number;
	preserved: number;
	total: number;
	pending?: number;
}

/** Folder in the backup bucket for each mirrored bucket. */
export type MirrorPrefix = "media" | "uploads";

export interface BackupEntry extends Manifest {
	createdAt: string;
}

export const STAMP = /^\d{4}-\d{2}-\d{2}T\d{4}Z$/;
export const FILE = /^[a-z0-9._-]+$/i;

/** 2026-10-03T1802Z — sortable, safe in object keys and URLs. */
export function makeStamp(date = new Date()): string {
	const iso = date.toISOString();
	return `${iso.slice(0, 13)}${iso.slice(14, 16)}Z`;
}

export function stampToDate(stamp: string): Date {
	return new Date(`${stamp.slice(0, 13)}:${stamp.slice(13, 15)}:00Z`);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** R2's smallest multipart part. Every part but the last must be the same size. */
export const PART_BYTES = 5 * 1024 * 1024;
/** Text handed to the gzip stream at a time. */
const FEED_BYTES = 64 * 1024;
const utf8 = new TextEncoder();

/** SHA-256 over a stream of chunks: Workers' DigestStream, else (Node tests) the chunks kept and hashed at the end. */
function digester(): { update(chunk: Uint8Array<ArrayBuffer>): Promise<void>; digest(): Promise<string> } {
	const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	const Stream = (crypto as unknown as { DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream;
	if (Stream) {
		const stream = new Stream("SHA-256");
		const writer = stream.getWriter();
		return {
			update: (chunk) => writer.write(chunk),
			digest: async () => {
				await writer.close();
				return hex(await stream.digest);
			},
		};
	}
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	return {
		update: async (chunk) => {
			chunks.push(chunk);
		},
		digest: () => sha256(concat(chunks, chunks.reduce((n, c) => n + c.byteLength, 0))),
	};
}

function concat(chunks: Uint8Array<ArrayBuffer>[], size: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/**
 * Gzip the dump's statements (one per line) straight into the backup bucket:
 * one put when it's under a part, else an R2 multipart upload in PART_BYTES
 * parts. Memory stays around one part plus a page of rows, however big the
 * database. Returns the stored size and SHA-256 of the gzip file.
 */
export async function writeDumpStream(
	bucket: R2Bucket,
	stamp: string,
	file: string,
	lines: AsyncIterable<string>,
	partBytes = PART_BYTES,
): Promise<{ bytes: number; sha256: string }> {
	const key = `d1/${stamp}/${file}`;
	const httpMetadata = { contentType: "application/gzip" };
	const gzip = new CompressionStream("gzip");
	const writer = gzip.writable.getWriter();
	// Feed the compressor while the loop below drains it (each waits on the other).
	/** An error from the dump itself (a failed query), which explains more than the stream errors it causes. */
	let dumpError: { error: unknown } | null = null;
	const feed = (async () => {
		let batch = "";
		const iterator = lines[Symbol.asyncIterator]();
		for (;;) {
			let next: IteratorResult<string>;
			try {
				next = await iterator.next();
			} catch (error) {
				dumpError = { error };
				throw error;
			}
			if (next.done) break;
			batch += `${next.value}\n`;
			if (batch.length >= FEED_BYTES) {
				await writer.write(utf8.encode(batch));
				batch = "";
			}
		}
		if (batch) await writer.write(utf8.encode(batch));
		await writer.close();
	})();
	feed.catch((error) => writer.abort(error).catch(() => undefined));

	const hash = digester();
	let pending: Uint8Array<ArrayBuffer>[] = [];
	let pendingBytes = 0;
	let bytes = 0;
	/** The first `size` pending bytes as one buffer; the rest stay pending. */
	const take = (size: number): Uint8Array<ArrayBuffer> => {
		const all = concat(pending, pendingBytes);
		pending = size < pendingBytes ? [all.slice(size)] : [];
		pendingBytes -= size;
		return size < all.byteLength ? all.slice(0, size) : all;
	};

	let upload: R2MultipartUpload | null = null;
	const parts: R2UploadedPart[] = [];
	const reader = gzip.readable.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const chunk = value as Uint8Array<ArrayBuffer>;
			bytes += chunk.byteLength;
			await hash.update(chunk);
			pending.push(chunk);
			pendingBytes += chunk.byteLength;
			while (pendingBytes >= partBytes) {
				upload ??= await bucket.createMultipartUpload(key, { httpMetadata });
				parts.push(await upload.uploadPart(parts.length + 1, take(partBytes)));
			}
		}
		await feed;
		const rest = take(pendingBytes);
		if (upload) {
			if (rest.byteLength) parts.push(await upload.uploadPart(parts.length + 1, rest));
			await upload.complete(parts);
		} else {
			await bucket.put(key, rest, { httpMetadata });
		}
	} catch (error) {
		await upload?.abort().catch(() => undefined);
		// Unblock the feed (it may be waiting for room in the stream) and let it finish.
		await reader.cancel(error).catch(() => undefined);
		await feed.catch(() => undefined);
		throw dumpError ? (dumpError as { error: unknown }).error : error;
	}
	return { bytes, sha256: await hash.digest() };
}

/** Write (or rewrite) a backup's manifest for a dump already stored. */
/**
 * Write (or rewrite) a backup's manifest. With a bucket lock on d1/ a manifest can be written once only
 * (R2 refuses to overwrite a locked object), so the backup then records the mirror counts in
 * mirrors/<stamp>.json instead of rewriting it (see writeMirrorCounts).
 */
export async function writeManifest(
	bucket: R2Bucket,
	stamp: string,
	file: string,
	written: { bytes: number; sha256: string },
	extra: Partial<Manifest>,
): Promise<Manifest> {
	const manifest: Manifest = { ...extra, stamp, file, bytes: written.bytes, sha256: written.sha256 };
	await bucket.put(`d1/${stamp}/manifest.json`, JSON.stringify(manifest, null, 1), {
		httpMetadata: { contentType: "application/json" },
	});
	return manifest;
}


/**
 * Mirror counts of a backup whose manifest can't be rewritten (d1/ is locked): kept outside every
 * locked prefix, at mirrors/<stamp>.json, and merged into the listing. Pruned with the backup.
 */
export const MIRRORS_PREFIX = "mirrors/";

export async function writeMirrorCounts(bucket: R2Bucket, stamp: string, counts: Pick<Manifest, "media" | "uploads">): Promise<void> {
	await bucket.put(`${MIRRORS_PREFIX}${stamp}.json`, JSON.stringify(counts), { httpMetadata: { contentType: "application/json" } });
}

/** The newest backup's stamp (from the d1/ folder names: one list call), or null when there's none. */
export async function newestStamp(bucket: R2Bucket): Promise<string | null> {
	let newest: string | null = null;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: "d1/", delimiter: "/", cursor });
		for (const prefix of page.delimitedPrefixes) {
			const stamp = prefix.slice(3, -1);
			if (STAMP.test(stamp) && (!newest || stamp > newest)) newest = stamp;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return newest;
}

/** Every backup with a manifest, newest first. */
export async function listBackups(bucket: R2Bucket): Promise<BackupEntry[]> {
	const stamps: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: "d1/", delimiter: "/", cursor });
		for (const prefix of page.delimitedPrefixes) {
			const stamp = prefix.slice(3, -1);
			if (STAMP.test(stamp)) stamps.push(stamp);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	const entries = await Promise.all(
		stamps.map(async (stamp) => {
			const object = await bucket.get(`d1/${stamp}/manifest.json`);
			if (!object) return null;
			try {
				const manifest = (await object.json()) as Manifest;
				return { ...manifest, stamp, createdAt: stampToDate(stamp).toISOString() };
			} catch {
				return null;
			}
		}),
	);
	const listed = entries.filter((e): e is BackupEntry => e !== null);
	// Mirror counts kept beside a locked manifest (one list call; a read only for the backups that have one).
	const sidecars = new Set<string>();
	let mirrorCursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: MIRRORS_PREFIX, cursor: mirrorCursor });
		for (const object of page.objects) sidecars.add(object.key.slice(MIRRORS_PREFIX.length).replace(/\.json$/, ""));
		mirrorCursor = page.truncated ? page.cursor : undefined;
	} while (mirrorCursor);
	await Promise.all(
		listed
			.filter((entry) => !entry.media && sidecars.has(entry.stamp))
			.map(async (entry) => {
				const object = await bucket.get(`${MIRRORS_PREFIX}${entry.stamp}.json`);
				const counts = object ? ((await object.json().catch(() => null)) as Pick<Manifest, "media" | "uploads"> | null) : null;
				if (counts?.media) entry.media = counts.media;
				if (counts?.uploads) entry.uploads = counts.uploads;
			}),
	);
	return listed.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/**
 * Mirror the media bucket into media/current/, moving anything replaced or
 * deleted since the last run to media/changed/<stamp>/ (same as the nightly
 * job's `rclone sync --backup-dir`). Compares by ETag.
 *
 * Copies at most `maxChanges` files per run so a large first mirror stays under
 * the Workers subrequest limit; the rest are reported as `pending` and copied
 * on the next run.
 */
export async function mirrorMedia(media: R2Bucket, backups: R2Bucket, stamp: string, maxChanges = 300): Promise<MirrorResult> {
	return mirrorBucket(media, backups, stamp, "media", maxChanges);
}

/** mirrorMedia for any bucket, into <prefix>/current/ and <prefix>/changed/<stamp>/. */
export async function mirrorBucket(
	media: R2Bucket,
	backups: R2Bucket,
	stamp: string,
	prefix: MirrorPrefix,
	maxChanges = 300,
): Promise<MirrorResult> {
	const current = `${prefix}/current/`;
	const source = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const page = await media.list({ cursor });
		for (const object of page.objects) source.set(object.key, object.etag);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	const mirror = new Map<string, string>();
	do {
		const page = await backups.list({ prefix: current, cursor });
		for (const object of page.objects) mirror.set(object.key.slice(current.length), object.etag);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	let copied = 0;
	let preserved = 0;
	const keep = async (key: string) => {
		const old = await backups.get(`${current}${key}`);
		if (!old) return;
		await backups.put(`${prefix}/changed/${stamp}/${key}`, old.body, { httpMetadata: old.httpMetadata });
		preserved++;
	};

	// Decide the changes first, then make them a few files at a time.
	const tasks: Array<() => Promise<void>> = [];
	let pending = 0;
	for (const [key, etag] of source) {
		if (mirror.get(key) === etag) continue;
		if (tasks.length >= maxChanges) {
			pending++;
			continue;
		}
		tasks.push(async () => {
			if (mirror.has(key)) await keep(key);
			const object = await media.get(key);
			if (!object) return;
			await backups.put(`${current}${key}`, object.body, { httpMetadata: object.httpMetadata });
			copied++;
		});
	}
	for (const key of mirror.keys()) {
		if (source.has(key)) continue;
		if (tasks.length >= maxChanges) {
			pending++;
			continue;
		}
		tasks.push(async () => {
			await keep(key);
			await backups.delete(`${current}${key}`);
		});
	}
	await inPool(tasks, MIRROR_CONCURRENCY);
	return { copied, preserved, total: source.size, pending };
}

/** Files copied at once when mirroring (each copy is a get and a put, streamed). */
export const MIRROR_CONCURRENCY = 8;

/** Run tasks with at most `limit` in flight; the first failure is thrown once the others settle. */
async function inPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | null = null;
	const worker = async () => {
		while (next < tasks.length && !failure) {
			const task = tasks[next++];
			try {
				await task();
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	if (failure) throw (failure as { error: unknown }).error;
}

/**
 * Copy media files that are in the backup mirror but missing from the media
 * bucket. Never overwrites. Copies at most `max` files per call so one request
 * stays well inside Worker limits; `pending` is what's left for the next call
 * (a coywolf.com restore trial copied 2,021 files in one request and took
 * over five minutes).
 */
export async function restoreMissingMedia(
	media: R2Bucket,
	backups: R2Bucket,
	max = 200,
	prefix: MirrorPrefix = "media",
): Promise<{ restored: number; checked: number; pending: number }> {
	const current = `${prefix}/current/`;
	const present = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await media.list({ cursor });
		for (const o of page.objects) present.add(o.key);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	let restored = 0;
	let checked = 0;
	let pending = 0;
	do {
		const page = await backups.list({ prefix: current, cursor });
		for (const o of page.objects) {
			checked++;
			const key = o.key.slice(current.length);
			if (present.has(key)) continue;
			if (restored >= max) {
				pending++;
				continue;
			}
			const object = await backups.get(o.key);
			if (!object) continue;
			await media.put(key, object.body, { httpMetadata: object.httpMetadata });
			restored++;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return { restored, checked, pending };
}

/**
 * Delete database backups and replaced media and upload copies older than `days`. Returns the number of
 * stamps pruned. A folder R2 refuses to delete (a bucket lock that keeps it longer than `days`) is left
 * for a later run, and the rest are still pruned. Not needed once the backup bucket has a lifecycle rule
 * doing the same (see retention.ts): the daily task then skips it.
 */
export async function pruneBackups(bucket: R2Bucket, days: number): Promise<number> {
	const cutoff = makeStamp(new Date(Date.now() - days * 86_400_000));
	let pruned = 0;
	let refused = 0;
	for (const prefix of ["d1/", "media/changed/", "uploads/changed/"]) {
		let cursor: string | undefined;
		do {
			const page = await bucket.list({ prefix, delimiter: "/", cursor });
			for (const dir of page.delimitedPrefixes) {
				const stamp = dir.slice(prefix.length, -1);
				if (!STAMP.test(stamp) || stamp >= cutoff) continue;
				try {
					await deletePrefix(bucket, dir);
					if (prefix === "d1/") pruned++;
				} catch (error) {
					refused++;
					if (refused === 1) console.warn(`coywolf backups: couldn't delete ${dir} (a bucket lock may still keep it); trying again tomorrow`, error);
				}
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
	// Mirror counts kept beside locked manifests go with their backup, never before it (a lock can keep the backup longer).
	const kept = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: "d1/", delimiter: "/", cursor });
		for (const dir of page.delimitedPrefixes) kept.add(dir.slice(3, -1));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	do {
		const page = await bucket.list({ prefix: MIRRORS_PREFIX, cursor });
		const old = page.objects.map((o) => o.key).filter((key) => {
			const stamp = key.slice(MIRRORS_PREFIX.length).replace(/\.json$/, "");
			return STAMP.test(stamp) && stamp < cutoff && !kept.has(stamp);
		});
		if (old.length) await bucket.delete(old).catch(() => undefined);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return pruned;
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/**
 * Batched counters. Counts made in one isolate within `delayMs` are written
 * together in one D1 batch after the response. The flush loop drains
 * `pending` until it's empty and clears `flushing` in the same synchronous
 * step, so a count either lands in a running flush or starts a new one; none
 * is left behind on a finished promise. A flush that hasn't ended
 * `staleMs` after it started (its timer belonged to a request that was
 * canceled, so it never will) is replaced by a new one, so counts aren't
 * left waiting on it. No imports, so `node --test` can load this file
 * directly.
 *
 * Used for file downloads (createDownloadCounter) and redirect hits
 * (src/redirects/middleware.ts): anyone can make either happen, so one D1
 * write per request would let a flood of uncached requests (a query string
 * skips the edge cache) write as fast as it can send.
 */

/** The slice of D1 the counter uses (stubbed in tests). */
export interface CountDb {
	prepare(sql: string): { bind(...values: unknown[]): unknown };
	batch(statements: unknown[]): Promise<unknown>;
}

/** One D1 statement adding `n` to the count of `id` (at `now`, ISO). */
export type CountStatement = (db: CountDb, id: string, n: number, now: string) => unknown;

export function createBatchedCounter(statement: CountStatement, options: { delayMs?: number; staleMs?: number; label: string }) {
	const pending = new Map<string, number>();
	let flushing: Promise<void> | null = null;
	let flushingSince = 0;
	let delayMs = options.delayMs ?? 1_000;
	let staleMs = options.staleMs ?? delayMs + 30_000;

	async function write(db: CountDb): Promise<void> {
		const batch = [...pending.entries()];
		pending.clear();
		const now = new Date().toISOString();
		await db.batch(batch.map(([id, n]) => statement(db, id, n, now)));
	}

	async function drain(db: CountDb, self: { flush: Promise<void> | null }): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		while (pending.size) {
			try {
				await write(db);
			} catch (error) {
				console.error(`coywolf-pack: could not record ${options.label}`, error);
			}
		}
		if (flushing === self.flush) flushing = null; // Same tick as the empty check above.
	}

	function startFlush(db: CountDb): Promise<void> {
		const self: { flush: Promise<void> | null } = { flush: null };
		self.flush = drain(db, self);
		flushing = self.flush;
		flushingSince = Date.now();
		return self.flush;
	}

	return {
		/** Count one for `id`; `waitUntil` keeps the shared flush alive past this response. */
		count(db: CountDb, id: string, waitUntil: (p: Promise<unknown>) => void): void {
			pending.set(id, (pending.get(id) ?? 0) + 1);
			const flush = flushing && Date.now() - flushingSince < staleMs ? flushing : startFlush(db);
			waitUntil(flush);
		},
		/** For tests: how long counts wait before they're written. */
		setDelay(ms: number): void {
			delayMs = ms;
			staleMs = ms + 30_000;
		},
		/** For tests. */
		get pendingSize() {
			return pending.size;
		},
		get idle() {
			return flushing === null;
		},
	};
}

const UPSERT = `INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision, created_at, updated_at)
	 VALUES (?1, ?2, ?3, json_object('downloads', ?4, 'lastDownload', ?5), ?6, ?5, ?5)
	 ON CONFLICT (plugin_id, collection, id) DO UPDATE SET
	   data = json_set(data, '$.downloads', COALESCE(json_extract(data, '$.downloads'), 0) + ?4, '$.lastDownload', ?5),
	   revision = ?6, updated_at = ?5`;

export function createDownloadCounter(pluginId: string, collection: string, delayMs = 1_000, staleMs = delayMs + 30_000) {
	return createBatchedCounter((db, id, n, now) => db.prepare(UPSERT).bind(pluginId, collection, id, n, now, crypto.randomUUID()), {
		delayMs,
		staleMs,
		label: "downloads",
	});
}

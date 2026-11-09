/**
 * Same-tick batching for the pack's own D1 reads. The pack reads the site
 * database through the raw binding (env.DB), which EmDash's per-request
 * session dialect never sees, so its reads were never coalesced: each was its
 * own round trip. Reads issued through here in the same tick (before a
 * zero-delay timer fires) go to D1 as one `db.batch()`: one round trip.
 *
 * A statement that fails fails the whole batch in D1, so on a batch error each
 * statement is retried on its own, and only the failing ones reject. Reads of
 * different requests are never batched together (Workers ties I/O to the
 * request that started it).
 *
 * Cancellation-safe (the hazard EmDash fixed as #1927): the flush runs on the
 * timer of whichever read queued first, and a request canceled after queueing
 * drops its timers. What protects every caller is its own deadline
 * (DEADLINES.d1ReadMs, on the caller's own timer): a read whose flush never
 * ran, or whose batch never answers, fails by then, and its callers fail
 * closed instead of hanging. The takeover below is a smaller thing: queues are
 * keyed by request context (requestStore(), or OUTSIDE for reads made outside
 * one), so a queue whose flush is DEADLINES.d1FlushReclaimMs overdue is only
 * ever found by a later read of the same context, which then schedules a flush
 * for both. A canceled request makes no more reads, so that mostly covers reads
 * outside a request context; it never reaches another request's queue.
 */
import { requestStore } from "./request-memo.js";
import { DEADLINES, withDeadline } from "./single-flight.js";

interface Pending {
	statement: D1PreparedStatement;
	resolve(result: D1Result<unknown>): void;
	reject(error: unknown): void;
}

/** Reads waiting for one flush, and the time by which that flush must have run. */
interface Queue {
	pending: Pending[];
	due: number;
}

/** Request context (or OUTSIDE) → database → reads waiting for this tick's batch. */
const queues = new WeakMap<object, Map<D1Database, Queue>>();
const OUTSIDE = {};

function flush(scope: Map<D1Database, Queue>, db: D1Database, queue: Queue): void {
	if (scope.get(db) === queue) scope.delete(db);
	const pending = queue.pending.splice(0);
	if (!pending.length) return;
	if (pending.length === 1 || typeof db.batch !== "function") {
		for (const p of pending) p.statement.all().then(p.resolve, p.reject);
		return;
	}
	db.batch(pending.map((p) => p.statement)).then(
		(results) => pending.forEach((p, i) => p.resolve(results[i] as D1Result<unknown>)),
		() => {
			// One bad statement fails a D1 batch: run them one by one so the others still answer.
			for (const p of pending) p.statement.all().then(p.resolve, p.reject);
		},
	);
}

/** Run a read with the other reads of this tick, in one D1 batch. Resolves to its rows. */
export function batchedAll<T = Record<string, unknown>>(db: D1Database, statement: D1PreparedStatement): Promise<T[]> {
	const read = new Promise<D1Result<unknown>>((resolve, reject) => {
		const owner = requestStore() ?? OUTSIDE;
		let scope = queues.get(owner);
		if (!scope) {
			scope = new Map();
			queues.set(owner, scope);
		}
		let queue = scope.get(db);
		let carried: Pending[] = [];
		if (queue && Date.now() > queue.due) {
			// Its flush never ran (the timer belonged to a request that was canceled): this read takes its queue over.
			carried = queue.pending.splice(0);
			scope.delete(db);
			queue = undefined;
		}
		if (!queue) {
			const fresh: Queue = { pending: carried, due: Date.now() + DEADLINES.d1FlushReclaimMs };
			scope.set(db, fresh);
			const pending = scope;
			setTimeout(() => flush(pending, db, fresh), 0);
			queue = fresh;
		}
		queue.pending.push({ statement, resolve, reject });
	});
	return withDeadline(read, DEADLINES.d1ReadMs, "a D1 read").then((result) => (result.results ?? []) as T[]);
}

/** Like batchedAll, the first row (null when none). */
export async function batchedFirst<T = Record<string, unknown>>(db: D1Database, statement: D1PreparedStatement): Promise<T | null> {
	return (await batchedAll<T>(db, statement))[0] ?? null;
}

/**
 * The last outcome of a scheduled task, for tasks that ask for it
 * (`recordOutcome` on their TaskDef): when it last ran, last succeeded and
 * last failed, and why. Alerts reads it (a failed backup), so a failure is
 * known without anyone opening the module's page.
 *
 * One plugin KV row per task, written once per run, so it's only for tasks
 * that run rarely (daily or weekly), never for the hourly ones.
 *
 * Kept free of EmDash imports so tests can load it directly.
 */

export interface TaskOutcome {
	lastRunAt: string;
	lastOkAt: string | null;
	lastFailedAt: string | null;
	/** The last failure's message (cleared by a success). */
	error: string | null;
}

interface Kv {
	get<T>(key: string): Promise<T | null | undefined>;
	set(key: string, value: unknown): Promise<void>;
}

export const taskOutcomeKey = (name: string) => `state:task:${name}`;

/** The task's last recorded outcome, or null when it hasn't run (or never recorded one). */
export async function readTaskOutcome(kv: Kv, name: string): Promise<TaskOutcome | null> {
	return (await kv.get<TaskOutcome>(taskOutcomeKey(name)).catch(() => null)) ?? null;
}

/** Record a run's outcome. Never throws: the task's own result matters more than the record. */
export async function recordTaskOutcome(kv: Kv, name: string, error: unknown, now = new Date()): Promise<void> {
	try {
		const previous = await readTaskOutcome(kv, name);
		const at = now.toISOString();
		const next: TaskOutcome = error
			? { lastRunAt: at, lastOkAt: previous?.lastOkAt ?? null, lastFailedAt: at, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
			: { lastRunAt: at, lastOkAt: at, lastFailedAt: previous?.lastFailedAt ?? null, error: null };
		await kv.set(taskOutcomeKey(name), next);
	} catch {
		// The record is best effort.
	}
}

/** Run a task's handler and record how it went; a failure is recorded and then thrown again (EmDash logs it). */
export async function withOutcome(kv: Kv, name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		await recordTaskOutcome(kv, name, error);
		throw error;
	}
	await recordTaskOutcome(kv, name, null);
}

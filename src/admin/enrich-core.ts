/**
 * AI Enrich in the entry editor's AI suggestions panel (since 0.52.0), the part
 * without React so Node can test it (src/admin/enrich.tsx draws it):
 *
 * - EmDash 1.6's editor draft as the pack uses it (`editorDraft` on a native
 *   panel's props; the pack declares its own minimal types, as PanelProps does).
 * - The run: a click reads the draft (get()), sends it to the pack's
 *   ai/editor-enrich route (src/ai/editor-enrich.ts), asks again on its own
 *   while the answer says `more` (at most MAX_ROUNDS, and only while the draft
 *   is unchanged), waits for another request that holds the entry, retries a
 *   lost answer once, and ends in a review, or a message. An answer the site
 *   refuses (signed out, no permission) ends it at once, and a draft that
 *   changed during a wait ends it stale before anything more is sent. Nothing
 *   changes in the editor until the person applies the review: then one
 *   patch() with the revision the click read, so an edit made meanwhile
 *   refuses it (stale).
 * - The run store: one run per entry (`collection:entryId`) at module level,
 *   so hiding the settings sidebar (which unmounts the panel) or a re-render
 *   doesn't lose it: the panel shows the run or its review when it mounts again.
 */
import { apiFetch, getErrorMessage } from "emdash/plugin-utils";

import { LEFT_ALONE_REASON, REVIEW_HINT } from "../ai/editor-images.js";
import { PACK_API } from "./api.js";

export { LEFT_ALONE_REASON };

// ── EmDash's editor draft (ContentEditorDraft, @emdash-cms/admin 1.6) ──

/** What get() returns: JSON copies of the form's values (missing → null, stored booleans 0/1), slug and SEO text. */
export interface Snapshot {
	revision: string;
	readOnly: boolean;
	fields: Record<string, unknown>;
	fieldDefinitions: Array<{ slug: string; type: string; validation?: Record<string, unknown> }>;
}

export type PatchCode = "EDITOR_DRAFT_STALE" | "EDITOR_DRAFT_READ_ONLY" | "EDITOR_DRAFT_INVALID";
export type PatchResult = { ok: true } | { ok: false; code: PatchCode; message: string };
export type DraftOperation = { op: "set"; field: string; value: unknown };

export interface EditorDraft {
	get(): Snapshot;
	/** All or nothing, synchronous, never throws. */
	patch(ops: ReadonlyArray<DraftOperation>, options: { expectedRevision: string }): PatchResult;
}

// ── The route's answer (src/ai/editor-enrich.ts) and ai/entry's enrich ──

export interface EnrichReview {
	/** `action`: a new link ("add"), or an existing link switched to glossary.io ("switch"; absent from a 0.52.0 pre-release server: a new link). */
	links: Array<{ name: string; slug: string; url: string; field: string; action?: "add" | "switch" }>;
	possessives: number;
	images: Array<{ field: string; mediaId: string | null; filename: string; alt?: string; caption?: string }>;
	description?: string;
	leftAlone: number;
	remaining: number;
}

export interface EnrichAnswer {
	toast: { message: string; type: "success" | "error" | "info" };
	patch?: { type: "editor-draft-patch"; operations: DraftOperation[] };
	revision?: string;
	more?: true;
	running?: true;
	review?: EnrichReview;
	progress?: { imagesDone: number; imagesTotal: number };
}

/** ai/entry's `enrich`: whether the button shows, what it adds, and where the entry's content goes. */
export interface EnrichInfo {
	available: boolean;
	links: boolean;
	images: boolean;
	describe: boolean;
	provider: string;
}

// ── Limits and wording ───────────────────────────────────────────

/** Requests per click when the answer says `more` (each one reuses what the last paid for). */
export const MAX_ROUNDS = 6;
/** Waits while another request holds the entry (a lost connection's request finishing), RUNNING_WAIT_MS apart. */
export const RUNNING_TRIES = 6;
export const RUNNING_WAIT_MS = 10_000;
/** A lost answer (network, 524, ANSWER_TIMEOUT_MS) is asked for again once, after RETRY_WAIT_MS. */
export const RETRY_WAIT_MS = 5_000;
/** A request answers in about 85 seconds at worst (src/ai/editor-enrich.ts START_BY_MS); past this one is lost. */
export const ANSWER_TIMEOUT_MS = 95_000;
/** The route's body cap (src/ai/editor-enrich.ts MAX_BODY_BYTES): a larger draft isn't sent at all. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** No request starts this long after the click, whatever the rounds, waits and retries added up to. */
export const MAX_RUN_MS = 10 * 60_000;
/** On a save, an ended run's message goes once it's this old (the autosave right after Apply leaves it). */
export const ENDED_KEEP_MS = 10_000;

export const MESSAGES = {
	working: "Working… (about half a minute)",
	stillWorking: "Still working…",
	checking: "Still checking…",
	otherRunning: "AI Enrich is already running for this entry. Checking again in 10 seconds…",
	readOnly: "The editor isn't accepting changes right now.",
	readOnlyApply: "The editor isn't accepting changes right now (a version is open, or the entry is locked). Close it, then choose Apply changes again.",
	invalid: "EmDash couldn't load these changes, so nothing was applied.",
	stale: "The entry changed while AI Enrich worked, so nothing was applied.",
	applied: "Added. Save or publish as usual.",
	didntFinish: "AI Enrich didn't finish. Click again: what was already paid for is kept.",
	tooLarge: "This entry is too large for AI Enrich (over 2 MB).",
} as const;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a refused patch means for the person (EmDash's own message is English for developers). */
export function messageFor(code: PatchCode): string {
	if (code === "EDITOR_DRAFT_STALE") return MESSAGES.stale;
	if (code === "EDITOR_DRAFT_READ_ONLY") return MESSAGES.readOnlyApply;
	return MESSAGES.invalid;
}

/** The request body: the whole snapshot (the route decides what it reads), the entry, and the round. */
export function buildBody(collection: string, entryId: string, snap: Snapshot, round: number) {
	return { collection, entryId, draft: { revision: snap.revision, fields: snap.fields, fieldDefinitions: snap.fieldDefinitions }, round };
}

/** The line under the button: what a click adds, and where the entry's content goes (EmDash's docs ask for both). */
export function explain(info: Pick<EnrichInfo, "links" | "images" | "describe" | "provider">): string {
	const adds = [info.links ? "glossary.io links" : "", info.images ? "alt text and captions for images that have none" : "", info.describe ? "a meta description if there isn't one" : ""].filter(Boolean);
	const list = adds.length > 2 || adds.some((a) => a.includes(" and ")) ? `${adds.slice(0, -1).join(", ")}, and ${adds.at(-1)}` : adds.join(" and ");
	const switches = info.links ? " A link you already have to a term's home page, Wikipedia article or profile is switched to glossary.io." : "";
	return `Adds ${adds.length > 1 ? list : adds[0] ?? "nothing"}.${switches} Sends this entry's ${info.images ? "text and images" : "text"} to ${info.provider}.`;
}

/** The review's Links heading: how many are new and how many are existing links switched. */
export function linksTitle(links: EnrichReview["links"]): string {
	const switched = links.filter((l) => l.action === "switch").length;
	const added = links.length - switched;
	if (!switched) return `Links (${links.length})`;
	return added ? `Links (${added} added, ${switched} switched)` : `Links (${switched} switched)`;
}

/** While a later round runs: the server's progress, when it has images. */
export function progressNote(answer?: EnrichAnswer): string {
	const p = answer?.progress;
	return p && p.imagesTotal > 0 ? `Working… ${p.imagesDone} of ${plural(p.imagesTotal, "image")} done.` : MESSAGES.stillWorking;
}

/** The operations Apply sends: the answer's, without the meta description when its box is off. */
export function operationsToApply(answer: EnrichAnswer, includeDescription: boolean): DraftOperation[] {
	return (answer.patch?.operations ?? []).filter((o) => includeDescription || o.field !== "seo.description");
}

/** The server's message in the review, when there's more to say than the lists (a limit, a busy Wikidata, images still to do), without its "review the changes" ending. */
export function reviewNote(answer: EnrichAnswer): string | null {
	if (answer.toast.type !== "success") return answer.toast.message.endsWith(REVIEW_HINT) ? answer.toast.message.slice(0, -REVIEW_HINT.length).trim() || null : answer.toast.message;
	const remaining = answer.review?.remaining ?? 0;
	return remaining ? `${plural(remaining, "image")} still to do: click AI Enrich again.` : null;
}

/** "m images left as they are", and why. */
export const leftAloneNote = (n: number) => `${plural(n, "image")} ${n === 1 ? "is" : "are"} left as ${n === 1 ? "it is" : "they are"}. ${LEFT_ALONE_REASON}`;

// ── The run and its store ────────────────────────────────────────

export type RunState =
	| { phase: "idle" }
	| { phase: "running"; round: number; note: string }
	| {
			phase: "review";
			answer: EnrichAnswer;
			/** The revision the click read: Apply patches only that draft. */
			revision: string;
			includeDescription: boolean;
			/** Why the last Apply didn't work (the review stays open). */
			error?: string;
			/** EmDash refused the meta description: Apply without it is offered. */
			withoutDescription?: boolean;
	  }
	| { phase: "applied"; message: string; at: number }
	| { phase: "stale"; message: string; at: number }
	| { phase: "failed"; message: string; at: number }
	| { phase: "done"; message: string; at: number };

type EndedPhase = "applied" | "stale" | "failed" | "done";
const ENDED: ReadonlySet<string> = new Set<EndedPhase>(["applied", "stale", "failed", "done"]);

const IDLE: RunState = { phase: "idle" };
const runs = new Map<string, RunState>();
const listeners = new Map<string, Set<() => void>>();

export const runKey = (collection: string, entryId: string) => `${collection}:${entryId}`;

/** The entry's run as it is now (the same object until it changes, for useSyncExternalStore). */
export function runState(key: string): RunState {
	return runs.get(key) ?? IDLE;
}

export function subscribeRun(key: string, listener: () => void): () => void {
	let set = listeners.get(key);
	if (!set) listeners.set(key, (set = new Set()));
	set.add(listener);
	return () => {
		set.delete(listener);
		if (!set.size) listeners.delete(key);
	};
}

function setRun(key: string, state: RunState): RunState {
	if (state.phase === "idle") runs.delete(key);
	else runs.set(key, state);
	for (const listener of [...(listeners.get(key) ?? [])]) listener();
	return state;
}

/** Back to the button alone: a review cancelled (nothing applied; the staged analysis stays for the publish), or a message dismissed. Never a running one. */
export function dismissRun(key: string): void {
	if (runState(key).phase !== "running") setRun(key, IDLE);
}

/**
 * An ended run's message goes (never a running run or an open review): when the panel unmounts, and on a save
 * (`olderThan`: only a message at least that old, so the autosave right after Apply leaves "Added" up).
 */
export function clearEnded(key: string, olderThan = 0): void {
	const state = runState(key);
	if (ENDED.has(state.phase) && enrichIo.now() - (state as { at: number }).at >= olderThan) setRun(key, IDLE);
}

/**
 * A review is only for the draft the click read: when the panel mounts or shows one, a draft that changed since (an
 * edit while the settings were hidden), or another draft object (the entry was left and opened again), ends it stale.
 */
export function checkReview(key: string, draft: EditorDraft): RunState {
	const state = runState(key);
	return state.phase === "review" && revisionNow(draft) !== state.revision ? end(key, "stale", MESSAGES.stale) : state;
}

/** An answer the site refused (HTTP 4xx): asking again can't help, and `message` is the site's own. */
export class RefusedError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "RefusedError";
		this.status = status;
	}
}

/** How a run talks to the route, waits and tells the time (tests replace them). */
export const enrichIo = {
	/**
	 * The route's answer. Throws RefusedError for a 4xx other than 408 and 429 (signed out, no permission, the plugin
	 * off, a body EmDash refuses), and any other error for an answer that's lost (the network, a 5xx, the zone's 524).
	 */
	send: async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
		const response = await apiFetch(`${PACK_API}/ai/editor-enrich`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
		if (response.ok) return ((await response.json()) as { data?: unknown }).data;
		const message = await getErrorMessage(response, "AI Enrich didn't answer");
		if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new RefusedError(response.status, response.status === 413 ? MESSAGES.tooLarge : message);
		throw new Error(`${message} (HTTP ${response.status})`);
	},
	wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	/** A request's deadline; a timeout rejects the fetch with a TimeoutError. */
	deadline: (ms: number): AbortSignal | undefined => (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined),
	now: () => Date.now(),
};

/** The run ends with a message. */
function end(key: string, phase: EndedPhase, message: string): RunState {
	return setRun(key, { phase, message, at: enrichIo.now() });
}

/** Whether a 200's data is an answer the run can read: a toast, and a patch of operations when it has one. */
function isAnswer(value: unknown): value is EnrichAnswer {
	const answer = value as EnrichAnswer | null | undefined;
	if (!answer || typeof answer !== "object" || !answer.toast || typeof answer.toast.message !== "string" || !["success", "error", "info"].includes(answer.toast.type)) return false;
	return answer.patch === undefined || (Boolean(answer.patch) && Array.isArray(answer.patch.operations));
}

/** A request body's size as JSON, in bytes (Infinity when it can't be serialized). */
function bodyBytes(body: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(body)).byteLength;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** The draft's revision now, or "" when it can't be read (the editor shows another entry, or unmounted). */
function revisionNow(draft: EditorDraft): string {
	try {
		return draft.get().revision;
	} catch {
		return "";
	}
}

/**
 * A click: run AI Enrich for the editor's draft, to a review or a message. Never throws. A second click while one
 * runs for the same entry does nothing (the button is disabled meanwhile).
 */
export async function startRun(collection: string, entryId: string, draft: EditorDraft): Promise<RunState> {
	const key = runKey(collection, entryId);
	if (runState(key).phase === "running") return runState(key);
	try {
		return await run(key, collection, entryId, draft);
	} catch (error) {
		// Nothing here should throw; whatever did, the run still ends (a running one can't be dismissed).
		console.warn("AI Enrich: the run failed", error);
		return end(key, "failed", MESSAGES.didntFinish);
	}
}

async function run(key: string, collection: string, entryId: string, draft: EditorDraft): Promise<RunState> {
	let snap: Snapshot;
	try {
		snap = draft.get();
	} catch {
		return end(key, "failed", MESSAGES.readOnly);
	}
	if (snap.readOnly || !snap.revision) return end(key, "failed", MESSAGES.readOnly);
	if (bodyBytes(buildBody(collection, entryId, snap, MAX_ROUNDS)) > MAX_BODY_BYTES) return end(key, "failed", MESSAGES.tooLarge);
	const started = enrichIo.now();
	const stale = () => end(key, "stale", MESSAGES.stale);
	/** After a wait: the draft is still the one the click read (a request for another could only be thrown away). */
	const unchanged = () => revisionNow(draft) === snap.revision;
	let round = 1;
	let retried = false;
	let waits = 0;
	setRun(key, { phase: "running", round, note: MESSAGES.working });
	for (;;) {
		if (enrichIo.now() - started > MAX_RUN_MS) return end(key, "failed", MESSAGES.didntFinish);
		let data: unknown;
		try {
			data = await enrichIo.send(buildBody(collection, entryId, snap, round), enrichIo.deadline(ANSWER_TIMEOUT_MS));
		} catch (error) {
			// Refused (signed out, no permission, the plugin off): asking again can't help, and the site says why.
			if (error instanceof RefusedError) return end(key, "failed", error.message || MESSAGES.didntFinish);
			// A lost answer (the network, a 5xx, the zone's 524, no answer in time): once more, and the lock's answer or
			// what the lost request staged decides.
			if (retried) {
				console.warn("AI Enrich: no answer", error);
				return end(key, "failed", MESSAGES.didntFinish);
			}
			retried = true;
			setRun(key, { phase: "running", round, note: MESSAGES.checking });
			await enrichIo.wait(RETRY_WAIT_MS);
			if (!unchanged()) return stale();
			continue;
		}
		if (!isAnswer(data)) {
			console.warn("AI Enrich: an answer it couldn't read", data);
			return end(key, "failed", MESSAGES.didntFinish);
		}
		const answer = data;
		retried = false;
		if (answer.running) {
			if (++waits > RUNNING_TRIES) return end(key, "failed", answer.toast.message);
			setRun(key, { phase: "running", round, note: MESSAGES.otherRunning });
			await enrichIo.wait(RUNNING_WAIT_MS);
			if (!unchanged()) return stale();
			continue;
		}
		// An answer for another draft than the one sent, or a draft that changed since: nothing more is paid for it.
		if (answer.revision !== undefined && answer.revision !== snap.revision) return stale();
		if (answer.more && round < MAX_ROUNDS) {
			if (!unchanged()) return stale();
			round++;
			setRun(key, { phase: "running", round, note: progressNote(answer) });
			continue;
		}
		if (answer.patch?.operations.length) {
			if (!unchanged()) return stale();
			return setRun(key, { phase: "review", answer, revision: snap.revision, includeDescription: true });
		}
		return end(key, answer.toast.type === "error" ? "failed" : "done", answer.toast.message);
	}
}

/** The review's "Fill the meta description" box. */
export function setIncludeDescription(key: string, on: boolean): void {
	const state = runState(key);
	if (state.phase === "review") setRun(key, { ...state, includeDescription: on, error: undefined, withoutDescription: undefined });
}

/**
 * Apply: one patch with the revision the click read. A read-only editor or one EmDash couldn't load keeps the review
 * open with the reason (Apply may be tried again: the revision still protects it); a changed draft ends stale.
 */
export function applyReview(key: string, draft: EditorDraft): RunState {
	const state = runState(key);
	if (state.phase !== "review") return state;
	const ops = operationsToApply(state.answer, state.includeDescription);
	if (!ops.length) return setRun(key, IDLE);
	let result: PatchResult;
	try {
		result = draft.patch(ops, { expectedRevision: state.revision });
	} catch (error) {
		result = { ok: false, code: "EDITOR_DRAFT_INVALID", message: String((error as Error)?.message ?? error) };
	}
	if (result.ok) return end(key, "applied", MESSAGES.applied);
	if (result.code === "EDITOR_DRAFT_STALE") return end(key, "stale", MESSAGES.stale);
	if (result.code === "EDITOR_DRAFT_READ_ONLY") return setRun(key, { ...state, error: MESSAGES.readOnlyApply, withoutDescription: undefined });
	console.warn("AI Enrich: EmDash refused the changes:", result.message);
	return setRun(key, { ...state, error: MESSAGES.invalid, withoutDescription: state.includeDescription && /seo\.description/.test(result.message) ? true : undefined });
}

/** Tests only. */
export function resetRunsForTests(): void {
	runs.clear();
	listeners.clear();
}

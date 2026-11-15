/**
 * The Buttondown API client: one function per call the module may make, and
 * nothing else. There's no generic request export.
 *
 * - ping, getEmail, listApiDrafts, createDraft, updateDraft, deleteDraft, checkKey.
 * - Every create sends `status: "draft"` (Buttondown's documented default is
 *   still `about_to_send`, so the Pack never relies on it).
 * - A guard inside the one sender refuses anything else before it reaches the
 *   network: a path with send-draft or publish in it, a method or path outside
 *   the list below, a DELETE that doesn't come from deleteDraft, the
 *   X-Buttondown-Live-Dangerously header, a JSON body whose status isn't
 *   "draft", and a PATCH that carries status, publish_date, filters,
 *   email_type or archival_mode.
 * - deleteDraft reads the email first, right before, and deletes only an
 *   untouched draft the Pack made: status "draft", the modification_date the
 *   Pack recorded after its own last write, and the Pack's key in its metadata.
 *   Buttondown's docs say a delete also removes the archive copy and cancels
 *   scheduled sends, which is why nothing else may ever delete.
 * - The host is the constant https://api.buttondown.com/v1 (the plugin's
 *   allowedHosts says the same), redirects are refused, email ids are checked
 *   against Buttondown's id pattern before they go in a path.
 * - The key goes only in the Authorization header and is scrubbed from every
 *   error. Bodies (sent or received) are never logged or put in errors; an
 *   error carries Buttondown's code and its detail, cut to 300 characters.
 *
 * Kept free of EmDash imports so tests can load it directly.
 */
import { type Fetch, scrubToken } from "../core/cloudflare-api.js";
import { DeadlineError, withDeadline } from "../core/single-flight.js";
import { fetchJson } from "../insights/http.js";
import { BUTTONDOWN_API, BUTTONDOWN_HOST, BUTTONDOWN_LIMITS } from "./keys.js";

/** Buttondown's email id: em_ and 26 base32 characters (or the older UUIDs). */
export const EMAIL_ID = /^(?:em_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}|(?:em_)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Fields the Pack writes. Everything else (publish_date, filters, archival_mode, email_type, template…) stays as Buttondown or you set it. */
export const WRITTEN_FIELDS = ["subject", "body", "description", "canonical_url", "image", "slug", "metadata"] as const;
/** Never in a PATCH: they'd schedule, send, retarget or re-archive an email. */
export const NEVER_PATCHED = ["status", "publish_date", "filters", "email_type", "archival_mode"] as const;
/** The header that skips Buttondown's safety checks. Never sent. */
export const LIVE_DANGEROUSLY = "x-buttondown-live-dangerously";

export interface DraftFields {
	subject: string;
	body: string;
	description?: string;
	canonical_url?: string;
	image?: string;
	slug?: string;
	metadata: Record<string, unknown>;
}

/** The parts of an email the Pack reads (never its body). */
export interface ButtondownEmail {
	id: string;
	status: string;
	subject: string;
	modificationDate: string | null;
	creationDate: string | null;
	metadata: Record<string, unknown>;
}

/** A refused or failed call. `status` 0: no answer (network error or deadline). */
export class ButtondownError extends Error {
	readonly status: number;
	readonly code: string | null;
	readonly detail: string;
	/** Seconds, from Retry-After. */
	readonly retryAfter: number | null;
	constructor(status: number, code: string | null, detail: string, retryAfter: number | null = null) {
		super(`Buttondown ${status || "didn't answer"}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`);
		this.name = "ButtondownError";
		this.status = status;
		this.code = code;
		this.detail = detail;
		this.retryAfter = retryAfter;
	}
}

/** A call the guard refused before it reached the network (a bug, never Buttondown's answer). */
export class ButtondownRefused extends Error {
	constructor(reason: string) {
		super(`Refused before sending: ${reason}`);
		this.name = "ButtondownRefused";
	}
}

/** Only deleteDraft holds this, so only deleteDraft can send a DELETE. */
const DELETE_GRANT = Symbol("buttondown-delete-draft");

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** The calls the module makes: method → the API paths (under /v1) it may use. */
const ALLOWED: Record<Method, RegExp[]> = {
	GET: [/^\/v1\/ping$/, /^\/v1\/emails$/, /^\/v1\/emails\/[A-Za-z0-9_-]+$/, /^\/v1\/newsletters$/, /^\/v1\/subscribers$/],
	POST: [/^\/v1\/emails$/],
	PATCH: [/^\/v1\/emails\/[A-Za-z0-9_-]+$/],
	DELETE: [/^\/v1\/emails\/[A-Za-z0-9_-]+$/],
};

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Text that's safe to store and show: the key and any credential masked, control characters dropped, at most 300 characters. */
export function safeDetail(text: string, key?: string | null): string {
	// Control characters in the pattern: strip them.
	return clip(scrubToken(text, key).replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), BUTTONDOWN_LIMITS.detailChars);
}

function guard(method: string, path: string, headers: Record<string, string>, body: unknown, grant?: symbol): URL {
	if (!(method in ALLOWED)) throw new ButtondownRefused(`method ${method}`);
	if (/send-draft|publish/i.test(path)) throw new ButtondownRefused("a sending path");
	if (!path.startsWith("/") || path.includes("//") || path.includes("..")) throw new ButtondownRefused("a path outside the API");
	const url = new URL(`${BUTTONDOWN_API}${path}`);
	if (url.protocol !== "https:" || url.hostname !== BUTTONDOWN_HOST || url.port || url.username || url.password) throw new ButtondownRefused("another host");
	if (!ALLOWED[method as Method].some((p) => p.test(url.pathname))) throw new ButtondownRefused(`${method} ${url.pathname}`);
	if (method === "DELETE" && grant !== DELETE_GRANT) throw new ButtondownRefused("a delete outside deleteDraft");
	if (Object.keys(headers).some((h) => h.toLowerCase() === LIVE_DANGEROUSLY)) throw new ButtondownRefused("the Live-Dangerously header");
	if (body !== undefined) {
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new ButtondownRefused("a body that isn't an object");
		const fields = body as Record<string, unknown>;
		if ("status" in fields && fields.status !== "draft") throw new ButtondownRefused("a status other than draft");
		if (method === "POST" && fields.status !== "draft") throw new ButtondownRefused("a create without status draft");
		if (method === "PATCH") for (const field of NEVER_PATCHED) if (field in fields) throw new ButtondownRefused(`${field} in an update`);
		for (const field of Object.keys(fields)) if (field !== "status" && !(WRITTEN_FIELDS as readonly string[]).includes(field)) throw new ButtondownRefused(`the field ${field}`);
	}
	return url;
}

/** Retry-After as seconds (a number of seconds or an HTTP date), or null. */
export function retryAfterSeconds(value: string | null | undefined, now = Date.now()): number | null {
	if (!value) return null;
	const n = Number(value.trim());
	if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), 86_400);
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : Math.max(0, Math.min(Math.ceil((at - now) / 1000), 86_400));
}

/** Buttondown's error body ({ code, detail }, or a validation list) as a code and a detail. */
function errorParts(body: unknown): { code: string | null; detail: string } {
	if (!body || typeof body !== "object") return { code: null, detail: "" };
	const b = body as Record<string, unknown>;
	const code = typeof b.code === "string" && /^[a-z0-9_]{1,64}$/i.test(b.code) ? b.code : null;
	let detail = "";
	if (typeof b.detail === "string") detail = b.detail;
	else if (Array.isArray(b.detail))
		detail = b.detail
			.map((d) => (d && typeof d === "object" ? [Array.isArray((d as { loc?: unknown }).loc) ? (d as { loc: unknown[] }).loc.slice(-1).join("") : "", (d as { msg?: unknown }).msg].filter((x) => typeof x === "string" && x).join(": ") : ""))
			.filter(Boolean)
			.join("; ");
	return { code, detail };
}

function toEmail(raw: unknown): ButtondownEmail | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.id !== "string" || !EMAIL_ID.test(e.id) || typeof e.status !== "string") return null;
	return {
		id: e.id,
		status: e.status,
		subject: typeof e.subject === "string" ? e.subject.slice(0, 2000) : "",
		modificationDate: typeof e.modification_date === "string" ? e.modification_date : null,
		creationDate: typeof e.creation_date === "string" ? e.creation_date : null,
		metadata: e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : {},
	};
}

/** The Pack's key in an email's metadata (coywolf_pack.key), or null. */
export function packKeyOf(email: Pick<ButtondownEmail, "metadata">): string | null {
	const mine = email.metadata.coywolf_pack;
	return mine && typeof mine === "object" && typeof (mine as { key?: unknown }).key === "string" ? (mine as { key: string }).key : null;
}

function pickFields(fields: Partial<DraftFields>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const name of WRITTEN_FIELDS) if (fields[name] !== undefined) out[name] = fields[name];
	return out;
}

const checkId = (id: string) => {
	if (typeof id !== "string" || !EMAIL_ID.test(id)) throw new ButtondownRefused("an email id that isn't Buttondown's");
	return id;
};

export type DeleteOutcome =
	| { outcome: "deleted" }
	| { outcome: "gone" }
	| { outcome: "left"; status: string }
	| { outcome: "edited"; email: ButtondownEmail };

export interface KeyCheck {
	/** GET /ping: 200 when the key works. */
	ping: number;
	/** The draft list: 200 when the key can read emails. */
	emails: number;
	/** GET /newsletters: 403 for a key limited to emails (200 would expose every newsletter's key). */
	newsletters: number;
	/** GET /subscribers: 403 for a key limited to emails. */
	subscribers: number;
}

export interface ButtondownClientOptions {
	key: string;
	/** ctx.http's fetch (contextFetch), so the plugin's allowed hosts apply. */
	fetch: Fetch;
	/** No call starts or runs past this time (ms since the epoch). Default: none beyond each call's 8 seconds. */
	deadlineAt?: number;
	now?: () => number;
}

export type ButtondownClient = ReturnType<typeof createButtondownClient>;

export function createButtondownClient(options: ButtondownClientOptions) {
	const { key } = options;
	const now = options.now ?? Date.now;
	if (typeof key !== "string" || !key.trim()) throw new ButtondownRefused("no API key");
	const baseHeaders = (): Record<string, string> => ({ Authorization: `Token ${key.trim()}`, Accept: "application/json" });

	const timeLeft = () => {
		const left = options.deadlineAt === undefined ? BUTTONDOWN_LIMITS.callMs : Math.min(BUTTONDOWN_LIMITS.callMs, options.deadlineAt - now());
		if (left < 500) throw new ButtondownError(0, "timeout", "No time left for another call in this run.");
		return left;
	};

	/** One JSON call through the guard. Returns the parsed body of a 2xx answer, or throws a ButtondownError. */
	async function send(method: Method, path: string, body?: Record<string, unknown>, grant?: symbol): Promise<{ status: number; body: unknown }> {
		const headers = baseHeaders();
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const url = guard(method, path, headers, body, grant);
		const ms = timeLeft();
		let answer: Awaited<ReturnType<typeof fetchJson>>;
		try {
			answer = await fetchJson(options.fetch, url.href, { method, headers, redirect: "error", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, ms, `Buttondown ${method} ${url.pathname}`, key);
		} catch (error) {
			if (error instanceof DeadlineError) throw new ButtondownError(0, "timeout", `Buttondown didn't answer within ${Math.round(ms / 1000)} seconds.`);
			throw new ButtondownError(0, "network", safeDetail(error instanceof Error ? error.message : String(error), key));
		}
		if (answer.status >= 200 && answer.status < 300) return { status: answer.status, body: answer.body };
		const { code, detail } = errorParts(answer.body);
		throw new ButtondownError(answer.status, code, safeDetail(detail, key), retryAfterSeconds(answer.retryAfter, now()));
	}

	/**
	 * A GET whose answer's status is all that's needed: the body is cancelled unread (with ctx.http, EmDash
	 * buffers it first, but the Pack never parses or keeps it). 0 when there was no answer.
	 */
	async function statusOnly(path: string): Promise<number> {
		const headers = baseHeaders();
		const url = guard("GET", path, headers, undefined);
		const ms = timeLeft();
		const controller = new AbortController();
		try {
			const response = await withDeadline(options.fetch(url.href, { method: "GET", headers, redirect: "error", signal: controller.signal }), ms, "Buttondown");
			await response.body?.cancel().catch(() => undefined);
			return response.status;
		} catch {
			controller.abort();
			return 0;
		}
	}

	async function getEmail(id: string): Promise<ButtondownEmail> {
		const { body } = await send("GET", `/emails/${encodeURIComponent(checkId(id))}`);
		const email = toEmail(body);
		if (!email) throw new ButtondownError(200, "unexpected_answer", "Buttondown's answer had no email in it.");
		return email;
	}

	return {
		/** GET /ping. */
		async ping(): Promise<number> {
			return statusOnly("/ping");
		},

		getEmail,

		/** Drafts made through the API, newest first, without their bodies (one page). */
		async listApiDrafts(page = 1): Promise<{ results: ButtondownEmail[]; hasMore: boolean }> {
			const n = Math.max(1, Math.min(Math.trunc(page), 100));
			const { body } = await send("GET", `/emails?status=draft&source=api&excluded_fields=body&ordering=-creation_date&page=${n}`);
			const b = (body ?? {}) as { results?: unknown; next?: unknown };
			const results = Array.isArray(b.results) ? b.results.map(toEmail).filter((e): e is ButtondownEmail => e !== null) : [];
			return { results, hasMore: typeof b.next === "string" && b.next.length > 0 };
		},

		/** POST /emails with status "draft", whatever the caller passes. */
		async createDraft(fields: DraftFields): Promise<ButtondownEmail> {
			const { body } = await send("POST", "/emails", { ...pickFields(fields), status: "draft" });
			const email = toEmail(body);
			if (!email) throw new ButtondownError(201, "unexpected_answer", "Buttondown's answer had no email in it.");
			return email;
		},

		/** PATCH /emails/{id} with the Pack's fields only (never status, publish_date, filters, email_type or archival_mode). */
		async updateDraft(id: string, fields: Partial<DraftFields>): Promise<ButtondownEmail> {
			const { body } = await send("PATCH", `/emails/${encodeURIComponent(checkId(id))}`, pickFields(fields));
			const email = toEmail(body);
			if (!email) throw new ButtondownError(200, "unexpected_answer", "Buttondown's answer had no email in it.");
			return email;
		},

		/**
		 * DELETE /emails/{id}, only when a read right before shows an untouched draft the Pack made: status "draft", the
		 * modification_date it recorded (`expectedModified`), and its key (`expectedKey`) in the metadata. Otherwise
		 * nothing is deleted and the outcome says why.
		 */
		async deleteDraft(id: string, expectedModified: string | null, expectedKey: string): Promise<DeleteOutcome> {
			checkId(id);
			let email: ButtondownEmail;
			try {
				email = await getEmail(id);
			} catch (error) {
				if (error instanceof ButtondownError && error.status === 404) return { outcome: "gone" };
				throw error;
			}
			if (email.status !== "draft") return { outcome: "left", status: email.status };
			if (!expectedModified || email.modificationDate !== expectedModified || packKeyOf(email) !== expectedKey) return { outcome: "edited", email };
			try {
				await send("DELETE", `/emails/${encodeURIComponent(id)}`, undefined, DELETE_GRANT);
			} catch (error) {
				if (error instanceof ButtondownError && error.status === 404) return { outcome: "gone" };
				throw error;
			}
			return { outcome: "deleted" };
		},

		/** Which areas the key reaches, by status code only: ping, the draft list, newsletters, subscribers. */
		async checkKey(): Promise<KeyCheck> {
			const [ping, emails, newsletters, subscribers] = await Promise.all([
				statusOnly("/ping"),
				statusOnly("/emails?status=draft&source=api&excluded_fields=body&page=1"),
				statusOnly("/newsletters"),
				statusOnly("/subscribers"),
			]);
			return { ping, emails, newsletters, subscribers };
		},
	};
}

/** For tests: the guard on its own (it's what every call goes through). */
export function guardForTests(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): URL {
	return guard(method, path, headers, body);
}

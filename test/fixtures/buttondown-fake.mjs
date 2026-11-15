// An in-memory Buttondown API (https://api.buttondown.com/v1) for tests: the calls Buttondown Drafts makes
// (ping, the email list, one email, create, update, delete, newsletters, subscribers), with statuses and
// modification dates that behave like the real ones (probed 2026-11-15: a PATCH that changes nothing keeps
// modification_date; one that changes a field moves it; a create's modification_date is a hair after its
// creation_date; DELETE answers 204, then the email is 404).
//
// It records every call and every safety violation (a send or publish path, the Live-Dangerously header,
// a create without status "draft", a PATCH with status/publish_date/filters/email_type/archival_mode, a DELETE
// whose email wasn't read just before, and any PATCH or DELETE of an email a person changed in Buttondown
// since the Pack's last write: edit() and setStatus() mark it, allowOverwrite() is the one way to let a
// PATCH through, for Refresh draft from post), and can be told to fail: a status with a body and headers, a
// network error, a call that never answers, "the call lands, then the answer is lost", or something that
// happens while a call is on its way (during).

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const FORBIDDEN_PATCH = ["status", "publish_date", "filters", "email_type", "archival_mode"];

export const FAKE_KEY = "bd-test-key-0123456789abcdefghijklmnop";

const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function fakeButtondown(options = {}) {
	const key = options.key ?? FAKE_KEY;
	const pageSize = options.pageSize ?? 20;
	/** id → email (with its body). */
	const emails = new Map();
	const calls = [];
	const violations = [];
	const failures = [];
	let seq = 0;
	let clock = Date.parse(options.start ?? "2026-11-15T12:00:00Z");
	const statusFor = { newsletters: options.newsletters ?? 403, subscribers: options.subscribers ?? 403 };
	/** The last email read (GET /emails/{id}), for "a DELETE comes right after its own read". */
	let lastRead = null;
	/** Emails a person changed in Buttondown since the Pack's last write (edit, setStatus): the Pack must not PATCH or DELETE them. */
	const human = new Set();
	/** Emails whose next PATCH may overwrite a person's changes (the admin confirmed Refresh draft from post). */
	const overwriteAllowed = new Set();

	const tick = (ms = 1000) => (clock += ms);
	const newId = () => {
		let n = ++seq;
		let tail = "";
		for (let i = 0; i < 25; i++) {
			tail = BASE32[n % 32] + tail;
			n = Math.floor(n / 32);
		}
		return `em_0${tail}`;
	};
	const publicEmail = (e, withBody = true) => ({ ...e, body: withBody ? e.body : "" });

	function route(method, url, body) {
		const path = url.pathname;
		if (method === "GET" && path === "/v1/ping") return json(200, {});
		if (method === "GET" && path === "/v1/newsletters") return json(statusFor.newsletters, statusFor.newsletters === 200 ? { results: [{ username: "other", api_key: "secret" }] } : { code: "forbidden", detail: "Forbidden." });
		if (method === "GET" && path === "/v1/subscribers") return json(statusFor.subscribers, statusFor.subscribers === 200 ? { results: [{ email_address: "reader@example.com" }] } : { code: "forbidden", detail: "Forbidden." });
		if (method === "GET" && path === "/v1/emails") {
			const status = url.searchParams.getAll("status");
			const source = url.searchParams.getAll("source");
			const noBody = url.searchParams.getAll("excluded_fields").includes("body");
			let list = [...emails.values()].filter((e) => (!status.length || status.includes(e.status)) && (!source.length || source.includes(e.source)));
			const ordering = url.searchParams.get("ordering") ?? "creation_date";
			list.sort((a, b) => (a.creation_date < b.creation_date ? -1 : 1) * (ordering.startsWith("-") ? -1 : 1));
			const page = Number(url.searchParams.get("page") ?? 1);
			const items = list.slice((page - 1) * pageSize, page * pageSize);
			const more = page * pageSize < list.length;
			return json(200, { count: list.length, next: more ? `${url.origin}${path}?page=${page + 1}` : null, previous: page > 1 ? "prev" : null, results: items.map((e) => publicEmail(e, !noBody)) });
		}
		const one = /^\/v1\/emails\/([^/]+)$/.exec(path);
		if (method === "POST" && path === "/v1/emails") {
			if (typeof body?.body === "string" && body.body.trimStart().startsWith("---")) return json(400, { code: "body_contains_frontmatter", detail: "Body starts with frontmatter." });
			if (body?.slug !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(body.slug)) return json(400, { code: "slug_invalid", detail: "Slug is invalid." });
			if (options.rejectSlugs?.includes(body?.slug)) return json(400, { code: "slug_invalid", detail: "That slug is taken." });
			const created = tick();
			const email = {
				id: newId(),
				status: body?.status ?? "about_to_send",
				source: "api",
				subject: body?.subject ?? "",
				body: body?.body ?? "",
				description: body?.description ?? "",
				canonical_url: body?.canonical_url ?? "",
				image: body?.image ?? "",
				slug: body?.slug ?? `email-${seq}`,
				metadata: body?.metadata ?? {},
				creation_date: new Date(created).toISOString(),
				// A hair after creation_date, as Buttondown's are (well within a second).
				modification_date: new Date(created + 1).toISOString(),
				absolute_url: "https://example.com/archive/x/",
			};
			emails.set(email.id, email);
			return json(201, publicEmail(email));
		}
		if (one && method === "GET") {
			const email = emails.get(one[1]);
			lastRead = one[1];
			return email ? json(200, publicEmail(email)) : json(404, { code: "not_found", detail: "Not found.", metadata: {} });
		}
		if (one && method === "PATCH") {
			const email = emails.get(one[1]);
			if (!email) return json(404, { code: "not_found", detail: "Not found.", metadata: {} });
			if (body?.slug !== undefined && options.rejectSlugs?.includes(body.slug)) return json(400, { code: "slug_invalid", detail: "That slug is taken." });
			let changed = false;
			for (const [field, value] of Object.entries(body ?? {})) {
				if (JSON.stringify(email[field]) !== JSON.stringify(value)) {
					email[field] = value;
					changed = true;
				}
			}
			if (changed) email.modification_date = new Date(tick()).toISOString();
			// The Pack's own write: the email is as the Pack left it again.
			human.delete(one[1]);
			overwriteAllowed.delete(one[1]);
			return json(200, publicEmail(email));
		}
		if (one && method === "DELETE") {
			if (!emails.has(one[1])) return json(404, { code: "not_found", detail: "Not found.", metadata: {} });
			emails.delete(one[1]);
			human.delete(one[1]);
			return new Response(null, { status: 204 });
		}
		return json(404, { code: "not_found", detail: "No such route." });
	}

	async function fetch(input, init = {}) {
		const url = new URL(input);
		const method = (init.method ?? "GET").toUpperCase();
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const call = { method, host: url.host, path: url.pathname, search: url.search, headers, body, redirect: init.redirect };
		calls.push(call);
		tick(10);
		// Safety: what the Pack must never do.
		if (url.origin !== "https://api.buttondown.com") violations.push(`another host: ${url.origin}`);
		if (/send-draft|publish/i.test(url.pathname)) violations.push(`a sending path: ${method} ${url.pathname}`);
		if ("x-buttondown-live-dangerously" in headers) violations.push("the Live-Dangerously header");
		if (method === "POST" && body?.status !== "draft") violations.push(`a create with status ${body?.status}`);
		if (body && "status" in body && body.status !== "draft") violations.push(`status ${body.status}`);
		if (method === "PATCH") for (const f of FORBIDDEN_PATCH) if (body && f in body) violations.push(`PATCH with ${f}`);
		if (method === "DELETE") {
			const id = url.pathname.split("/").pop();
			const previous = calls.at(-2);
			if (!previous || previous.method !== "GET" || previous.path !== url.pathname || lastRead !== id) violations.push(`a DELETE without its own read just before: ${id}`);
			else if (emails.get(id)?.status !== "draft") violations.push(`a DELETE of a non-draft: ${id}`);
			if (human.has(id)) violations.push(`a DELETE of an email changed in Buttondown: ${id}`);
		}
		if (method === "PATCH") {
			const id = url.pathname.split("/").pop();
			if (emails.has(id) && emails.get(id).status !== "draft") violations.push(`a PATCH of a non-draft: ${id}`);
			if (human.has(id) && !overwriteAllowed.has(id)) violations.push(`a PATCH of an email changed in Buttondown: ${id}`);
		}
		if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
		if (headers.authorization !== `Token ${key}`) return json(401, { code: "unauthorized", detail: `Invalid token ${String(headers.authorization ?? "").slice(6)}` });
		const at = failures.findIndex((f) => f.match(call));
		if (at >= 0) {
			const f = failures[at];
			if (!f.persist) failures.splice(at, 1);
			// Something else happens while this call is on its way (another job runs); then it goes through as usual.
			if (f.during) {
				await f.during(call);
				return route(method, url, body);
			}
			if (f.network) throw new TypeError(f.message ?? "fetch failed: connection refused");
			if (f.hang) return new Promise(() => {});
			if (f.lose) {
				route(method, url, body);
				throw new TypeError("fetch failed: connection reset");
			}
			return json(f.status, f.body ?? { code: f.code ?? "error", detail: f.detail ?? "Something went wrong." }, f.headers ?? {});
		}
		return route(method, url, body);
	}

	return {
		key,
		emails,
		calls,
		violations,
		fetch,
		/** The plugin context's http (contextFetch uses it). */
		http: { fetch },
		/** Queue a failure for the next call that matches ({ method, path } or a function), or every one with persist. */
		fail(match, response) {
			const test = typeof match === "function" ? match : (c) => (!match.method || c.method === match.method) && (!match.path || (match.path instanceof RegExp ? match.path.test(c.path) : c.path === match.path));
			failures.push({ match: test, ...response });
		},
		clearFailures() {
			failures.length = 0;
		},
		/** Someone changed the email in Buttondown (its modification_date moves). */
		edit(id, fields) {
			const email = emails.get(id);
			Object.assign(email, fields);
			email.modification_date = new Date(tick()).toISOString();
			human.add(id);
		},
		/** The admin confirmed Refresh draft from post: the next PATCH of this email may overwrite what a person changed. */
		allowOverwrite(id) {
			overwriteAllowed.add(id);
		},
		/** Whether a person changed the email in Buttondown since the Pack's last write. */
		changedByHand(id) {
			return human.has(id);
		},
		/**
		 * Buttondown moved the email to another status (Jon scheduled or sent it). `keepModified`: one of Buttondown's own
		 * transitions that may leave modification_date alone (paused → draft), not verified against the real API.
		 */
		setStatus(id, status, { keepModified = false } = {}) {
			const email = emails.get(id);
			email.status = status;
			if (!keepModified) {
				email.modification_date = new Date(tick()).toISOString();
				human.add(id);
			}
		},
		/** Calls of one kind: "POST /v1/emails", "PATCH", "DELETE"… */
		count(kind) {
			const [method, path] = kind.split(" ");
			return calls.filter((c) => c.method === method && (!path || c.path === path || (path.endsWith("*") && c.path.startsWith(path.slice(0, -1))))).length;
		},
		drafts() {
			return [...emails.values()].filter((e) => e.status === "draft");
		},
		setAccess(area, status) {
			statusFor[area] = status;
		},
	};
}

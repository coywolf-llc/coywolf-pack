/**
 * Minimal Cloudflare Stream API client (the parts the Videos module uses).
 * Same endpoints and token as EmDash's cloudflareStream() media provider,
 * which this module doesn't depend on: that provider resolves its
 * credentials from env at import time and has no captions, downloads or
 * webhook calls.
 */
import { CLOUDFLARE_API, CloudflareApiError, cloudflareApi } from "../core/cloudflare-api.js";

const API = CLOUDFLARE_API;

export interface StreamCredentials {
	accountId: string;
	token: string;
}

export interface StreamVideo {
	uid: string;
	thumbnail?: string;
	preview?: string;
	readyToStream?: boolean;
	status?: { state?: string; pctComplete?: string; errorReasonText?: string };
	meta?: Record<string, unknown>;
	creator?: string | null;
	created?: string;
	modified?: string;
	uploaded?: string;
	size?: number;
	duration?: number;
	input?: { width?: number; height?: number };
	allowedOrigins?: string[];
	requireSignedURLs?: boolean;
	playback?: { hls?: string; dash?: string };
}

export interface StreamCaption {
	language: string;
	label?: string;
	generated?: boolean;
	status?: string;
}

export class StreamError extends Error {
	// A plain field, not a parameter property, so `node --test` can load this file (type stripping).
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export function streamClient(creds: StreamCredentials) {
	const base = `${API}/accounts/${encodeURIComponent(creds.accountId)}/stream`;
	const auth = { Authorization: `Bearer ${creds.token}` };

	/**
	 * One API call through the shared client (src/core/cloudflare-api.ts): a deadline, and no token in errors.
	 * Stream keeps the global fetch (not ctx.http): its tus and caption calls rely on headers and multipart
	 * bodies that ctx.http's redirect handling and request buffering weren't checked against.
	 */
	async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
		try {
			return (await cloudflareApi<T>(`/accounts/${encodeURIComponent(creds.accountId)}/stream${path}`, { token: creds.token, method, body, headers })).result;
		} catch (error) {
			if (!(error instanceof CloudflareApiError)) throw error;
			const detail = error.errors.map((e) => e.message).filter(Boolean).join(" ");
			throw new StreamError(detail || `Cloudflare Stream returned HTTP ${error.status}.`, error.status);
		}
	}

	const id = (uid: string) => `/${encodeURIComponent(uid)}`;

	return {
		list: (limit = 1000) => call<StreamVideo[]>("GET", `?limit=${limit}&asc=false`),
		get: (uid: string) => call<StreamVideo>("GET", id(uid)),
		update: (uid: string, fields: Record<string, unknown>) => call<StreamVideo>("POST", id(uid), { uid, ...fields }),
		remove: (uid: string) => call<unknown>("DELETE", id(uid)),
		/** Minutes stored and the account's limit. */
		storageUsage: () => call<{ videoCount?: number; totalStorageMinutes?: number; totalStorageMinutesLimit?: number }>("GET", "/storage-usage"),
		directUpload: (opts: { maxDurationSeconds: number; meta: Record<string, string> }) =>
			call<{ uploadURL: string; uid: string }>("POST", "/direct_upload", { maxDurationSeconds: opts.maxDurationSeconds, meta: opts.meta }),

		/** One-time tus upload URL for large files (the browser uploads straight to Stream). */
		async tusUpload(opts: { length: number; maxDurationSeconds: number; name: string }): Promise<{ uploadURL: string; uid: string | null }> {
			const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
			const res = await fetch(`${base}?direct_user=true`, {
				method: "POST",
				headers: {
					...auth,
					"Tus-Resumable": "1.0.0",
					"Upload-Length": String(opts.length),
					"Upload-Metadata": `name ${b64(opts.name)},maxdurationseconds ${b64(String(opts.maxDurationSeconds))}`,
				},
			});
			const location = res.headers.get("Location");
			if (!res.ok || !location) throw new StreamError(`Cloudflare Stream refused the upload (HTTP ${res.status}).`, res.status);
			return { uploadURL: location, uid: res.headers.get("stream-media-id") };
		},

		getDownloads: (uid: string) => call<{ default?: { status?: string; url?: string; percentComplete?: number } }>("GET", `${id(uid)}/downloads`),
		createDownload: (uid: string) => call<{ default?: { status?: string; url?: string; percentComplete?: number } }>("POST", `${id(uid)}/downloads`),
		deleteDownload: (uid: string) => call<unknown>("DELETE", `${id(uid)}/downloads`),

		listCaptions: (uid: string) => call<StreamCaption[]>("GET", `${id(uid)}/captions`),
		uploadCaption(uid: string, lang: string, vtt: string) {
			const form = new FormData();
			form.append("file", new Blob([vtt], { type: "text/vtt" }), `${lang}.vtt`);
			return call<StreamCaption>("PUT", `${id(uid)}/captions/${encodeURIComponent(lang)}`, form);
		},
		generateCaption: (uid: string, lang: string) => call<StreamCaption>("POST", `${id(uid)}/captions/${encodeURIComponent(lang)}/generate`),
		deleteCaption: (uid: string, lang: string) => call<unknown>("DELETE", `${id(uid)}/captions/${encodeURIComponent(lang)}`),
		async captionVtt(uid: string, lang: string): Promise<string> {
			const res = await fetch(`${base}${id(uid)}/captions/${encodeURIComponent(lang)}/vtt`, { headers: auth });
			if (!res.ok) throw new StreamError(`Could not download the ${lang} captions (HTTP ${res.status}).`, res.status);
			return res.text();
		},

		setWebhook: (notificationUrl: string) => call<{ notificationUrl?: string; secret?: string }>("PUT", "/webhook", { notificationUrl }),
		getWebhook: () => call<{ notificationUrl?: string } | null>("GET", "/webhook"),
		deleteWebhook: () => call<unknown>("DELETE", "/webhook"),
	};
}

export type StreamClient = ReturnType<typeof streamClient>;

/**
 * The few R2 S3-API calls large uploads need: start, upload a part of, complete and
 * abort a multipart upload, and delete an object. Requests are signed with ./sigv4.ts.
 */
import { encodeXml, xmlValue } from "./r2-rules.js";
import { EMPTY_SHA256, type SigV4Credentials, UNSIGNED_PAYLOAD, sha256Hex, signRequest } from "./sigv4.js";

export { MAX_THROUGH_SITE, PART_SIZE, partSizeFor } from "./r2-rules.js";

export interface R2Config extends SigV4Credentials {
	accountId: string;
	bucket: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function r2Host(accountId: string): string {
	return `${accountId}.r2.cloudflarestorage.com`;
}

export class S3Error extends Error {
	readonly status: number;
	readonly code?: string;
	constructor(message: string, status: number, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function r2Client(config: R2Config, fetchImpl: Fetch) {
	const host = r2Host(config.accountId);
	const objectPath = (key: string) => `/${config.bucket}/${key}`;

	async function call(
		method: string,
		path: string,
		options: { query?: Record<string, string>; headers?: Record<string, string>; body?: string | Uint8Array } = {},
	): Promise<{ status: number; text: string; headers: Headers }> {
		// A part's bytes go unsigned (TLS protects them; hashing megabytes per request costs CPU).
		const payloadHash = options.body instanceof Uint8Array ? UNSIGNED_PAYLOAD : options.body ? await sha256Hex(options.body) : EMPTY_SHA256;
		const signed = await signRequest(
			{ method, host, path, query: options.query, headers: options.headers, region: "auto" },
			config,
			payloadHash,
		);
		const response = await fetchImpl(signed.url, { method, headers: signed.headers, body: options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body });
		const text = await response.text();
		if (!response.ok) {
			const code = xmlValue(text, "Code");
			const message = xmlValue(text, "Message") ?? `R2 answered ${response.status}`;
			throw new S3Error(code ? `${code}: ${message}` : message, response.status, code);
		}
		return { status: response.status, text, headers: response.headers };
	}

	return {
		async createMultipart(key: string, contentType: string): Promise<string> {
			const { text } = await call("POST", objectPath(key), {
				query: { uploads: "" },
				headers: { "content-type": contentType || "application/octet-stream" },
			});
			const uploadId = xmlValue(text, "UploadId");
			if (!uploadId) throw new S3Error("R2 didn't return an upload ID.", 502);
			return uploadId;
		},

		/** Uploads one part; returns its ETag (for completeMultipart). */
		async uploadPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array): Promise<string> {
			const { headers } = await call("PUT", objectPath(key), { query: { partNumber: String(partNumber), uploadId }, body: bytes });
			const etag = headers.get("etag");
			if (!etag) throw new S3Error("R2 didn't return an ETag for the part.", 502);
			return etag;
		},

		async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<string | undefined> {
			const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
			const body = `<CompleteMultipartUpload>${sorted
				.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${encodeXml(p.etag)}</ETag></Part>`)
				.join("")}</CompleteMultipartUpload>`;
			const { text } = await call("POST", objectPath(key), {
				query: { uploadId },
				headers: { "content-type": "application/xml" },
				body,
			});
			// S3 can answer 200 with an <Error> body.
			if (text.includes("<Error>")) throw new S3Error(xmlValue(text, "Message") ?? "Completing the upload failed.", 500, xmlValue(text, "Code"));
			return xmlValue(text, "ETag");
		},

		async abortMultipart(key: string, uploadId: string): Promise<void> {
			try {
				await call("DELETE", objectPath(key), { query: { uploadId } });
			} catch (error) {
				if (!(error instanceof S3Error && error.status === 404)) throw error;
			}
		},

		async headObject(key: string): Promise<{ size: number; etag: string | null } | null> {
			try {
				const { headers } = await call("HEAD", objectPath(key));
				return { size: Number(headers.get("content-length") ?? 0), etag: headers.get("etag") };
			} catch (error) {
				if (error instanceof S3Error && error.status === 404) return null;
				throw error;
			}
		},

		async deleteObject(key: string): Promise<void> {
			await call("DELETE", objectPath(key));
		},
	};
}


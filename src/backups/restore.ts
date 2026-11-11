/**
 * Restores, through the Cloudflare API (a Worker can't create databases or
 * time-travel through its D1 binding).
 *
 * Rewinding rolls the live database back, including this plugin's own
 * settings and storage, so everything a restore depends on lives outside the
 * database: the API token is a Worker secret, the account and database IDs are
 * plugin options, and undo points are written to the backup bucket.
 */
import { PluginRouteError } from "emdash";

import { CloudflareApiError, type Fetch, cloudflareApi } from "../core/cloudflare-api.js";
import { DeadlineError } from "../core/single-flight.js";
import { stampToDate } from "./store.js";

/** One file per rewind, newest last: undo pops the most recent, so earlier states stay reachable. */
const UNDO_PREFIX = "restore/undo/";

export interface RestoreConfig {
	token: string;
	accountId: string;
	databaseId: string;
	/** For the Cloudflare API calls: the route's ctx.http when it has one (default: the global fetch). */
	fetch?: Fetch;
}

export interface UndoPoint {
	/** Bookmark of the database just before the rewind. */
	bookmark: string;
	rewoundAt: string;
	rewoundTo: string;
}

/** How long one D1 restore call may take: Time Travel restores and imports answer slower than other API calls. */
const RESTORE_CALL_MS = 60_000;

/** One D1 call through the shared client (src/core/cloudflare-api.ts): a deadline, ctx.http when the route passes it, no token in errors. */
async function cf<T>(config: RestoreConfig, path: string, init: { method?: string; body?: string } = {}): Promise<T> {
	try {
		return (await cloudflareApi<T>(`/accounts/${config.accountId}${path}`, { token: config.token, fetch: config.fetch, method: init.method ?? "GET", body: init.body, permission: "Account → D1 → Edit", tokenName: "restore token (BACKUPS_API_TOKEN, or the backups.restore tokenSecret)", deadlineMs: RESTORE_CALL_MS })).result;
	} catch (error) {
		// Surface the API's message in the admin (plain Errors become a generic 500).
		if (error instanceof CloudflareApiError) throw PluginRouteError.badRequest(error.message);
		// The call ran out of time, but Cloudflare may still carry it out.
		if (error instanceof DeadlineError) {
			throw PluginRouteError.badRequest("Cloudflare didn't answer within a minute. The restore may still be finishing at Cloudflare: reload this page before trying again.");
		}
		throw error;
	}
}

const db = (config: RestoreConfig) => `/d1/database/${config.databaseId}`;

export async function currentBookmark(config: RestoreConfig): Promise<string> {
	const result = await cf<{ bookmark: string }>(config, `${db(config)}/time_travel/bookmark`);
	return result.bookmark;
}

/** Roll the live database back to a backup's moment, saving an undo point first. */
export async function rewind(
	config: RestoreConfig,
	backups: R2Bucket,
	target: { stamp: string; bookmark?: string },
): Promise<UndoPoint> {
	const query = target.bookmark
		? `bookmark=${encodeURIComponent(target.bookmark)}`
		: `timestamp=${encodeURIComponent(stampToDate(target.stamp).toISOString())}`;
	const before = await currentBookmark(config);
	const undo: UndoPoint = { bookmark: before, rewoundAt: new Date().toISOString(), rewoundTo: target.stamp };
	await backups.put(`${UNDO_PREFIX}${undo.rewoundAt}.json`, JSON.stringify(undo), {
		httpMetadata: { contentType: "application/json" },
	});
	await cf(config, `${db(config)}/time_travel/restore?${query}`, { method: "POST" });
	return undo;
}

async function latestUndoKey(backups: R2Bucket): Promise<string | null> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await backups.list({ prefix: UNDO_PREFIX, cursor });
		for (const o of page.objects) keys.push(o.key);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys.sort().at(-1) ?? null;
}

/** The most recent rewind that hasn't been undone. */
export async function getUndo(backups: R2Bucket): Promise<UndoPoint | null> {
	const key = await latestUndoKey(backups);
	const object = key ? await backups.get(key) : null;
	return object ? ((await object.json()) as UndoPoint) : null;
}

/** Return the database to where it was before the most recent rewind. */
export async function undoRewind(config: RestoreConfig, backups: R2Bucket): Promise<UndoPoint> {
	const key = await latestUndoKey(backups);
	const object = key ? await backups.get(key) : null;
	if (!key || !object) throw PluginRouteError.badRequest("There is no rewind to undo.");
	const undo = (await object.json()) as UndoPoint;
	await cf(config, `${db(config)}/time_travel/restore?bookmark=${encodeURIComponent(undo.bookmark)}`, { method: "POST" });
	await backups.delete(key);
	return undo;
}

async function md5(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	// MD5 is what D1's import API uses as the upload ETag (Workers support it in WebCrypto).
	const digest = await crypto.subtle.digest("MD5", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ImportStatus {
	status?: "active" | "complete" | "error";
	at_bookmark?: string;
	upload_url?: string;
	filename?: string;
	error?: string;
	success?: boolean;
}

export interface NewDatabaseRestore {
	databaseId: string;
	databaseName: string;
	tables: number;
	rows: number;
	mismatches: Record<string, [number, number | undefined]>;
}

/**
 * Import a dump into a brand-new D1 database and verify row counts. The live
 * site keeps running on its current database until its binding is switched.
 */
export async function restoreToNewDatabase(
	config: RestoreConfig,
	databaseName: string,
	sql: string,
): Promise<NewDatabaseRestore> {
	const suffix = crypto.randomUUID().slice(0, 6);
	const created = await cf<{ uuid: string; name: string }>(config, "/d1/database", {
		method: "POST",
		body: JSON.stringify({ name: `${databaseName}-${suffix}` }),
	});
	const target: RestoreConfig = { ...config, databaseId: created.uuid };
	try {
		return await importAndVerify(target, created, sql);
	} catch (error) {
		// Don't leave a half-imported database behind.
		await cf(config, `/d1/database/${created.uuid}`, { method: "DELETE" }).catch(() => undefined);
		throw error;
	}
}

async function importAndVerify(
	target: RestoreConfig,
	created: { uuid: string; name: string },
	sql: string,
): Promise<NewDatabaseRestore> {
	const path = `${db(target)}/import`;

	const bytes = new TextEncoder().encode(sql) as Uint8Array<ArrayBuffer>;
	const etag = await md5(bytes);
	const init = await cf<ImportStatus>(target, path, { method: "POST", body: JSON.stringify({ action: "init", etag }) });
	if (init.upload_url) {
		const put = await fetch(init.upload_url, { method: "PUT", body: bytes });
		if (!put.ok) throw PluginRouteError.badRequest(`Uploading the dump failed (${put.status})`);
	}
	let status = await cf<ImportStatus>(target, path, {
		method: "POST",
		body: JSON.stringify({ action: "ingest", etag, filename: init.filename }),
	});
	const bookmark = status.at_bookmark;
	for (let i = 0; status.status !== "complete" && status.status !== "error" && i < 60; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		status = await cf<ImportStatus>(target, path, {
			method: "POST",
			body: JSON.stringify({ action: "poll", current_bookmark: bookmark }),
		});
	}
	if (status.status !== "complete") {
		throw PluginRouteError.badRequest(`Import ${status.status ?? "timed out"}: ${status.error ?? "no details"}`);
	}

	// Verify: rows per table in the dump vs. the new database.
	const expected = new Map<string, number>();
	for (const match of sql.matchAll(/^INSERT INTO "((?:[^"]|"")+)"/gm)) {
		const table = match[1].replace(/""/g, '"');
		expected.set(table, (expected.get(table) ?? 0) + 1);
	}
	const tables = [...expected.keys()];
	const actual = new Map<string, number>();
	for (let i = 0; i < tables.length; i += 5) {
		// D1 allows at most 5 terms in a compound SELECT.
		const sqlCounts = tables
			.slice(i, i + 5)
			.map((t) => `SELECT '${t.replace(/'/g, "''")}' AS t, count(*) AS n FROM "${t.replace(/"/g, '""')}"`)
			.join(" UNION ALL ");
		const result = await cf<Array<{ results: Array<{ t: string; n: number }> }>>(target, `${db(target)}/query`, {
			method: "POST",
			body: JSON.stringify({ sql: sqlCounts }),
		});
		for (const row of result[0]?.results ?? []) actual.set(row.t, row.n);
	}
	const mismatches: NewDatabaseRestore["mismatches"] = {};
	for (const [table, n] of expected) if (actual.get(table) !== n) mismatches[table] = [n, actual.get(table)];

	return {
		databaseId: created.uuid,
		databaseName: created.name,
		tables: tables.length,
		rows: [...expected.values()].reduce((a, b) => a + b, 0),
		mismatches,
	};
}

export { restoreMissingMedia } from "./store.js";

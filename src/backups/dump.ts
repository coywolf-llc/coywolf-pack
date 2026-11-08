/**
 * Restorable SQL dump of a D1 database, built from inside the Worker.
 *
 * Same output order as scripts/backup/d1-backup.sh, so either kind of dump
 * restores with scripts/backup/d1-restore.sh:
 *
 *   1. CREATE TABLE for every regular table
 *   2. FTS5 search tables and the triggers that maintain them
 *   3. INSERT rows, one statement per line (the search triggers re-index
 *      content rows as they load)
 *   4. indexes and the remaining triggers
 *
 * FTS5 shadow tables are skipped: SQLite recreates them with the virtual table.
 *
 * D1 rejects any statement over 100 KB (SQLITE_TOOBIG), but the site writes
 * rows with bound parameters, so a long post can be bigger than that. A row
 * whose INSERT would be too long is written with its long text values cut
 * short, followed by UPDATEs that append the rest in pieces under the limit.
 */

interface MasterRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

const PAGE_SIZE = 500;
/**
 * About how much a read of rows should return. D1 refuses query results over 50 MB (from
 * November 4, 2026); 500 rows of a table with very large rows (long posts, revisions) could
 * pass that, so each read is sized from the bytes the previous one returned.
 */
export const PAGE_TARGET_BYTES = 8 * 1024 * 1024;
/** How D1 words a result over its size limit (its message has said "too large", "exceeds" or "limit" with a size). */
const RESULT_TOO_LARGE = /too large|too big|exceed|size limit|limit.*(bytes|MB)|SQLITE_TOOBIG/i;

/** Rows to ask for next, from the size of the rows just read. */
export function nextPageSize(pageBytes: number, rows: number): number {
	if (rows <= 0) return PAGE_SIZE;
	const perRow = Math.max(1, pageBytes / rows);
	return Math.max(1, Math.min(PAGE_SIZE, Math.floor(PAGE_TARGET_BYTES / perRow)));
}
const SEARCH_PREFIX = "_emdash_fts_";
/** Longest statement written, in UTF-8 bytes; D1's limit is 100,000. */
export const MAX_STATEMENT_BYTES = 90_000;
/** Most UTF-8 bytes of escaped text per piece of a split value. */
const PIECE_BYTES = 60_000;
/** In a row too long for one INSERT, text values longer than this are appended separately. */
const SHORT_BYTES = 2_000;
/**
 * Line breaks are written as '||char(10)||', two operators each, and SQLite
 * refuses expressions deeper than 1,000: at most this many per statement.
 */
const MAX_BREAKS = 400;
const breaks = (s: string) => s.match(/[\r\n]/g)?.length ?? 0;
/** Option rows that the plugin rebuilds on demand; not worth backing up. */
const SKIP_OPTION = /^plugin:coywolf-pack:cache:/;

function isInternal(name: string): boolean {
	return name.startsWith("sqlite_") || name.startsWith("_cf_");
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** SQL literal for a D1 value, keeping every statement on one line (like sqlite3 .dump). */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "boolean") return value ? "1" : "0";
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value)) {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: Array.isArray(value)
					? Uint8Array.from(value as number[])
					: new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength);
		let hex = "";
		for (const b of bytes) hex += b.toString(16).padStart(2, "0");
		return `X'${hex}'`;
	}
	// Newlines become ||char(10)|| so each INSERT stays on one line.
	return `'${escapeText(String(value))}'`;
}

function escapeText(text: string): string {
	return text.replace(/'/g, "''").replace(/\r/g, "'||char(13)||'").replace(/\n/g, "'||char(10)||'");
}

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;

/** Split text into pieces whose escaped form stays under PIECE_BYTES (never inside a surrogate pair). */
export function splitText(text: string): string[] {
	const pieces: string[] = [];
	let start = 0;
	let size = 0;
	let lines = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
		const char = pair ? text.slice(i, i + 2) : text[i];
		const cost = bytes(escapeText(char));
		const isBreak = char === "\n" || char === "\r";
		if ((size + cost > PIECE_BYTES || (isBreak && lines >= MAX_BREAKS)) && i > start) {
			pieces.push(text.slice(start, i));
			start = i;
			size = 0;
			lines = 0;
		}
		size += cost;
		if (isBreak) lines++;
		if (pair) i++;
	}
	pieces.push(text.slice(start));
	return pieces;
}

/**
 * One row as statements: a single INSERT when it fits, otherwise an INSERT
 * with each long text value's first piece, then UPDATEs appending the rest.
 * `key` names the columns that identify the row (primary key, or rowid).
 */
export function rowStatements(table: string, row: Record<string, unknown>, key: Record<string, unknown>): string[] {
	const columns = Object.keys(row).filter((c) => c !== ROWID);
	const insert = (values: Record<string, unknown>) =>
		`INSERT INTO ${table} (${columns.map(quoteIdent).join(",")}) VALUES(${columns.map((c) => sqlLiteral(values[c])).join(",")});`;
	const whole = insert(row);
	const lineCount = columns.reduce((n, c) => n + (typeof row[c] === "string" ? breaks(row[c] as string) : 0), 0);
	if (bytes(whole) <= MAX_STATEMENT_BYTES && lineCount <= MAX_BREAKS) return [whole];

	// Long text values start empty and are appended piece by piece, so the
	// INSERT holds only short values however many long columns the row has.
	const first: Record<string, unknown> = { ...row };
	const rest: Array<[string, string]> = [];
	for (const c of columns) {
		const value = row[c];
		if (typeof value !== "string" || (bytes(sqlLiteral(value)) <= SHORT_BYTES && breaks(value) <= 20)) continue;
		first[c] = "";
		for (const piece of splitText(value)) rest.push([c, piece]);
	}
	const where = Object.entries(key)
		.map(([c, v]) => `${c === ROWID ? "rowid" : quoteIdent(c)}=${sqlLiteral(v)}`)
		.join(" AND ");
	return [
		insert(first),
		...rest.map(([c, piece]) => `UPDATE ${table} SET ${quoteIdent(c)}=${quoteIdent(c)}||${sqlLiteral(piece)} WHERE ${where};`),
	];
}

/** Alias for rowid in dump queries of tables without a primary key. */
const ROWID = "__coywolf_rowid";

/**
 * Parents before children. D1 may apply a large import in several batches, so
 * PRAGMA defer_foreign_keys can't be relied on to cover forward references.
 */
async function orderByForeignKeys(db: D1Database, tables: MasterRow[]): Promise<MasterRow[]> {
	const names = new Set(tables.map((t) => t.name));
	const parents = new Map<string, Set<string>>();
	for (const t of tables) {
		const { results } = await db.prepare(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`).all<{ table: string }>();
		parents.set(t.name, new Set(results.map((r) => r.table).filter((p) => p !== t.name && names.has(p))));
	}
	const ordered: MasterRow[] = [];
	const done = new Set<string>();
	const visiting = new Set<string>();
	const byName = new Map(tables.map((t) => [t.name, t]));
	const visit = (name: string) => {
		if (done.has(name) || visiting.has(name)) return; // a cycle falls back to name order
		visiting.add(name);
		for (const parent of parents.get(name) ?? []) visit(parent);
		visiting.delete(name);
		done.add(name);
		ordered.push(byName.get(name)!);
	};
	for (const t of tables) visit(t.name);
	return ordered;
}

export interface DumpResult {
	sql: string;
	tables: number;
	rows: number;
}

/** The whole dump as one string (tests, small databases). Backups stream dumpLines instead. */
export async function dumpDatabase(db: D1Database): Promise<DumpResult> {
	const counts = { tables: 0, rows: 0 };
	const out: string[] = [];
	for await (const line of dumpLines(db, counts)) out.push(line);
	return { sql: `${out.join("\n")}\n`, ...counts };
}

/** Columns that, when a table declares them, hide the real rowid from `rowid` in queries. */
const ROWID_NAMES = new Set(["rowid", "_rowid_", "oid"]);

/**
 * The dump, one statement per item (no trailing newline), read a page of rows
 * at a time so memory stays bounded however big the database is. `counts` is
 * filled in as it goes (complete once the iteration ends). Tables with a
 * rowid are paged by rowid (`WHERE rowid > ?`), which stays fast on big
 * tables where OFFSET rescans every earlier row; WITHOUT ROWID tables use OFFSET.
 */
export async function* dumpLines(db: D1Database, counts: { tables: number; rows: number } = { tables: 0, rows: 0 }): AsyncGenerator<string> {
	const { results: master } = await db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
		.all<MasterRow>();

	const isSearch = (row: MasterRow) =>
		row.name.startsWith(SEARCH_PREFIX) || row.tbl_name.startsWith(SEARCH_PREFIX) || (row.sql ?? "").includes(SEARCH_PREFIX);

	const tables = master.filter((r) => r.type === "table" && !isInternal(r.name) && !r.name.startsWith(SEARCH_PREFIX));
	const searchTables = master.filter(
		(r) => r.type === "table" && r.name.startsWith(SEARCH_PREFIX) && /^CREATE VIRTUAL TABLE/i.test(r.sql ?? ""),
	);
	const searchTriggers = master.filter((r) => r.type === "trigger" && r.name.startsWith(SEARCH_PREFIX));
	const indexes = master.filter((r) => r.type === "index" && !isInternal(r.name) && !isSearch(r));
	const triggers = master.filter((r) => r.type === "trigger" && !isSearch(r));

	const ordered = await orderByForeignKeys(db, tables);

	const statement = (sql: string) => `${sql.trim().replace(/;$/, "")};`;
	counts.tables = tables.length;
	yield "PRAGMA defer_foreign_keys=TRUE;";

	for (const t of tables) yield statement((t.sql ?? "").replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS "));
	for (const t of searchTables) yield statement(t.sql ?? "");
	for (const t of searchTriggers) yield statement(t.sql ?? "");

	for (const t of ordered) {
		const table = quoteIdent(t.name);
		const { results: info } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string; pk: number }>();
		const withRowid = !/WITHOUT\s+ROWID/i.test(t.sql ?? "");
		// A column named rowid (or oid) shadows the real one: page that table by OFFSET.
		const byRowid = withRowid && !info.some((c) => ROWID_NAMES.has(c.name.toLowerCase()));
		const pk = info.filter((c) => c.pk > 0).map((c) => c.name);
		// Rows are identified by primary key for split values; tables without one by rowid.
		const keyColumns = pk.length || !withRowid ? pk : [ROWID];
		// The rowid alias is never written out (rowStatements skips it); it's the paging cursor.
		const select = byRowid || (withRowid && !pk.length) ? `rowid AS ${ROWID}, *` : "*";
		const order = withRowid ? " ORDER BY rowid" : "";
		let after: unknown = null;
		let offset = 0;
		let limit = PAGE_SIZE;
		for (;;) {
			let results: Record<string, unknown>[];
			try {
				({ results } = byRowid
					? await db
							.prepare(`SELECT ${select} FROM ${table}${after === null ? "" : ` WHERE rowid > ?`}${order} LIMIT ?`)
							.bind(...(after === null ? [limit] : [after, limit]))
							.all<Record<string, unknown>>()
					: await db
							.prepare(`SELECT ${select} FROM ${table}${order} LIMIT ? OFFSET ?`)
							.bind(limit, offset)
							.all<Record<string, unknown>>());
			} catch (error) {
				// D1 refuses results over 50 MB (from November 4, 2026). Ask again for fewer rows, down to one.
				// Any other error (an outage, a bad query) goes straight up instead of being retried.
				if (limit === 1 || !RESULT_TOO_LARGE.test(String(error))) throw error;
				limit = Math.max(1, Math.floor(limit / 4));
				continue;
			}
			let pageBytes = 0;
			for (const row of results) {
				if (t.name === "options" && typeof row.name === "string" && SKIP_OPTION.test(row.name)) continue;
				const key = Object.fromEntries(keyColumns.map((c) => [c, row[c]]));
				for (const sql of rowStatements(table, row, key)) {
					pageBytes += sql.length;
					yield sql;
				}
				counts.rows++;
			}
			if (results.length < limit) break;
			offset += results.length;
			if (byRowid) after = results[results.length - 1][ROWID];
			// Size the next read from this one: about PAGE_TARGET_BYTES, never more than PAGE_SIZE rows.
			limit = nextPageSize(pageBytes, results.length);
		}
	}

	for (const i of indexes) yield statement(i.sql ?? "");
	for (const t of triggers) yield statement(t.sql ?? "");
}

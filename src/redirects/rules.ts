/**
 * Redirect rules: storage (a table in the site's D1 database, so backups and
 * rewinds include it), validation, and matching. Shared by the plugin routes
 * and the site middleware.
 *
 * Complements EmDash's built-in redirects, which only accept site-relative
 * destinations and skip any path with a file extension.
 */

import { batchedAll } from "../core/d1-batch.js";
import { sharedRead, sharedSlot } from "../core/single-flight.js";

export const REDIRECT_TYPES = [301, 302, 307, 308, 410] as const;
export type RedirectType = (typeof REDIRECT_TYPES)[number];

export interface RedirectRule {
	id: string;
	source: string;
	target: string;
	type: RedirectType;
	isRegex: boolean;
	enabled: boolean;
	hits: number;
	lastHit: string | null;
	note: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface RedirectInput {
	source: string;
	target?: string;
	type?: number;
	isRegex?: boolean;
	enabled?: boolean;
	note?: string | null;
}

const TABLE = "coywolf_redirects";

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS ${TABLE} (
		id TEXT PRIMARY KEY,
		source TEXT NOT NULL,
		target TEXT NOT NULL DEFAULT '',
		type INTEGER NOT NULL DEFAULT 301,
		is_regex INTEGER NOT NULL DEFAULT 0,
		enabled INTEGER NOT NULL DEFAULT 1,
		hits INTEGER NOT NULL DEFAULT 0,
		last_hit TEXT,
		note TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_source ON ${TABLE} (source, is_regex)`,
	// The site middleware reads the (few) pattern rules without scanning the exact ones.
	`CREATE INDEX IF NOT EXISTS ${TABLE}_patterns ON ${TABLE} (source) WHERE is_regex = 1`,
];

export async function ensureTable(db: D1Database): Promise<void> {
	await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

interface Row {
	id: string;
	source: string;
	target: string;
	type: number;
	is_regex: number;
	enabled: number;
	hits: number;
	last_hit: string | null;
	note: string | null;
	created_at: string;
	updated_at: string;
}

const toRule = (r: Row): RedirectRule => ({
	id: r.id,
	source: r.source,
	target: r.target,
	type: r.type as RedirectType,
	isRegex: r.is_regex === 1,
	enabled: r.enabled === 1,
	hits: r.hits,
	lastHit: r.last_hit,
	note: r.note,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** Exact sources match with or without a trailing slash, so store them without one. */
export function normalizePath(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The key an exact source is stored and looked up by: normalized the way Astro normalizes a request's pathname
 * (decode, then re-encode through the URL parser, as EmDash 1.5's own redirects do: normalizeSourcePath in
 * emdash/src/redirects/patterns.ts), so a source typed with raw Unicode (`/café`) and the request's
 * percent-encoded path (`/caf%C3%A9`) compare equal. Without a trailing slash, as normalizePath.
 */
export function sourceKey(path: string): string {
	if (path.includes("?") || path.includes("#")) return normalizePath(path);
	try {
		const url = new URL("http://placeholder.invalid");
		url.pathname = decodeURI(path);
		return normalizePath(url.pathname);
	} catch {
		return normalizePath(path);
	}
}

/**
 * The forms an exact rule may be stored under for a request path: its key, and (for rules saved before 0.38.0,
 * which kept raw Unicode as typed) the key decoded. One or two values.
 */
export function storedForms(pathname: string): string[] {
	const key = sourceKey(pathname);
	let decoded = key;
	try {
		decoded = decodeURI(key);
	} catch {
		// A malformed escape: the key is the only form.
	}
	return decoded === key ? [key] : [key, decoded];
}

/**
 * How an exact source is saved: its key decoded back to readable characters (`/café`, as typed, rather than
 * `/caf%C3%A9`), so the Redirects page shows it the way it was entered. Lookups try both forms (storedForms).
 */
export function storedSource(path: string): string {
	return storedForms(path).at(-1) ?? sourceKey(path);
}

/** Non-ASCII characters in a redirect's Location, percent-encoded (a header value must be ASCII), as EmDash 1.5 does. */
export function encodeLocation(location: string): string {
	return location.replace(/[^\p{ASCII}]+/gu, encodeURIComponent);
}

export class RedirectValidationError extends Error {}

/** Longest request path tried against pattern rules; longer paths match exact rules only (bounds a slow pattern's cost per request). */
export const MAX_PATTERN_PATH = 512;

/** A literal character as written in a pattern (`\/` and `/` are the same). */
const literal = (c: string) => (c.length === 2 && c.startsWith("\\") && !/[A-Za-z0-9]/.test(c[1] as string) ? c[1] : c);

/**
 * A repeated group whose own repeat can't overlap between iterations: `[^X]+X`
 * or `X[^X]+` (or `*`), where X is one literal character. Each iteration then
 * ends (or starts) at the next X, so there's one way to split a path, such as
 * the common `(?:[^/]+/)*` for "any number of path segments".
 */
function unambiguousRepeat(body: string): boolean {
	const ends = /^\[\^(\\.|[^\\\]])\][+*](\\.|[^\\()[\]{}|*+?^$.])$/.exec(body);
	if (ends && literal(ends[1] as string) === literal(ends[2] as string)) return true;
	const starts = /^(\\.|[^\\()[\]{}|*+?^$.])\[\^(\\.|[^\\\]])\][+*]$/.exec(body);
	return Boolean(starts && literal(starts[1] as string) === literal(starts[2] as string));
}

/** Alternatives that are plain words starting with different characters (`jpg|png`): each iteration has one way to match. */
function distinctWords(body: string): boolean {
	const words = body.split("|");
	if (!words.every((w) => /^(?:[A-Za-z0-9_\-/]|\\[./-])+$/.test(w))) return false;
	const firsts = words.map((w) => literal(w.startsWith("\\") ? w.slice(0, 2) : (w[0] as string)));
	return new Set(firsts).size === firsts.length;
}

/** Most unbounded repeats of a broad atom (`.*`, `\S+`, `[^x]*`…) in one pattern: each more multiplies the work on a long path. */
export const MAX_WILDCARD_REPEATS = 2;

/** What follows an atom: no quantifier, `?`, a fixed count (`{n}`), a bounded repeat (`{n,m}`) or an unbounded one (`*`, `+`, `{n,}`). */
interface Quantifier {
	/** Characters it takes, with a lazy `?` after it. */
	len: number;
	kind: "none" | "optional" | "fixed" | "bounded" | "unbounded";
	/** Most times the atom may match (Infinity when unbounded). */
	max: number;
}

function quantifierAt(source: string, i: number): Quantifier {
	const c = source[i];
	const lazy = (len: number) => (source[i + len] === "?" ? len + 1 : len);
	if (c === "*" || c === "+") return { len: lazy(1), kind: "unbounded", max: Number.POSITIVE_INFINITY };
	if (c === "?") return { len: lazy(1), kind: "optional", max: 1 };
	const m = c === "{" ? /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i)) : null;
	if (!m) return { len: 0, kind: "none", max: 1 };
	if (m[2] === undefined) return { len: lazy(m[0].length), kind: "fixed", max: Number(m[1]) };
	if (m[3] === "") return { len: lazy(m[0].length), kind: "unbounded", max: Number.POSITIVE_INFINITY };
	return { len: lazy(m[0].length), kind: "bounded", max: Number(m[3]) };
}

/** A broad atom: `.`, `\S`, `\D`, `\W`, `\w`, a class like `[\s\S]`, or a negated class that lets `/` through. */
function broadAtom(atom: string): boolean {
	if (atom === "." || /^\\[SDWw]$/.test(atom)) return true;
	if (!atom.startsWith("[")) return false;
	if (/\\s[^\]]*\\S|\\S[^\]]*\\s|\\d[^\]]*\\D|\\D[^\]]*\\d|\\w[^\]]*\\W|\\W[^\]]*\\w/.test(atom)) return true;
	return atom.startsWith("[^") && !/\/|\\\//.test(atom);
}

/**
 * A pattern that can take exponential (or steeply polynomial) time on a path
 * that almost matches, found by reading the pattern (escapes and character
 * classes skipped). Every request whose path has no exact rule runs every
 * pattern, so one such pattern lets anyone burn the Worker's CPU:
 * - a repeated group (`*`, `+`, `{n,}`, or `{n}`/`{n,m}` above 1) whose body
 *   can match in more than one way: it contains a repeat, an optional part
 *   (`?`) or alternatives, as in `(a+)+`, `(aa?)*` (41 characters took 12 s),
 *   `(.?.)*`, `(a|a){30}` or `(a|ab)+`. Allowed: an inner repeat that can't
 *   overlap (unambiguousRepeat: `(?:[^/]+/)*`, `(?:/[^/]+)+`) and plain words
 *   that start differently (`(?:jpg|png)+`). A fixed count inside (`{4}`)
 *   doesn't make a body ambiguous;
 * - more than MAX_WILDCARD_REPEATS unbounded repeats of a broad atom, such as
 *   `(.*)(.*)(.*)(.*)x` (400 characters took 3.4 s).
 * Some fast patterns are refused too; they can be written another way.
 * Returns the reason, or null.
 */
export function nestedRepeat(source: string): string | null {
	interface Group {
		start: number;
		/** Contains a repeat or an optional part (directly or in a group inside it). */
		ambiguous: boolean;
		/** Contains alternatives (directly or in a group inside it). */
		alt: boolean;
	}
	const root = (): Group => ({ start: -1, ambiguous: false, alt: false });
	const stack: Group[] = [];
	let top = root();
	let wildcards = 0;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "(") {
			stack.push(top);
			top = { start: i, ambiguous: false, alt: false };
			continue;
		}
		if (c === "|") {
			top.alt = true;
			continue;
		}
		if (c === ")") {
			const group = top;
			top = stack.pop() ?? root();
			const body = source.slice(group.start + 1, i).replace(/^\?(?::|<[=!]|<[^>]*>|[=!])/, "");
			const q = quantifierAt(source, i + 1);
			if (q.kind !== "none" && q.kind !== "optional" && q.max > 1) {
				const safe = unambiguousRepeat(body) || (group.alt && !group.ambiguous && distinctWords(body));
				if (group.ambiguous && !safe) return "it repeats a group that can match in more than one way (such as (a+)+ or (aa?)*)";
				if (group.alt && !safe) return "it repeats a group of alternatives that can match the same text (such as (a|ab)+)";
			}
			if (group.ambiguous || group.alt || (q.kind !== "none" && q.kind !== "fixed")) top.ambiguous = true;
			if (group.alt) top.alt = true;
			i += q.len;
			continue;
		}
		// One atom: an escape, a class, `.`, or a literal character.
		let end = i + 1;
		if (c === "\\") end = i + 2;
		else if (c === "[") {
			// In JavaScript `[]` is empty, so the first unescaped `]` ends the class.
			let j = i + 1;
			for (; j < source.length && source[j] !== "]"; j++) if (source[j] === "\\") j++;
			end = j + 1;
		}
		const atom = source.slice(i, end);
		const q = quantifierAt(source, end);
		if (q.kind !== "none" && q.kind !== "fixed") top.ambiguous = true;
		if (q.kind === "unbounded" && broadAtom(atom) && ++wildcards > MAX_WILDCARD_REPEATS) {
			return `it has more than ${MAX_WILDCARD_REPEATS} open-ended wildcards (such as .* or [^x]+)`;
		}
		i = end - 1 + q.len;
	}
	return null;
}

/** Validate and normalize a rule; throws RedirectValidationError with a readable message. */
/**
 * `unchangedPattern`: the rule already exists with this very pattern (enabling, disabling, editing its target
 * or note, re-importing an export), so the speed check is skipped: patterns saved before it existed stay editable.
 */
export function validate(input: RedirectInput, options: { unchangedPattern?: boolean } = {}): Omit<RedirectInput, "type"> & { type: RedirectType; target: string } {
	const source = (input.source ?? "").trim();
	const target = (input.target ?? "").trim();
	const type = (input.type ?? 301) as RedirectType;
	const isRegex = input.isRegex === true;

	if (!REDIRECT_TYPES.includes(type)) throw new RedirectValidationError(`Type must be one of ${REDIRECT_TYPES.join(", ")}.`);
	if (isRegex) {
		if (!source) throw new RedirectValidationError("Enter a pattern.");
		try {
			new RegExp(source);
		} catch (error) {
			throw new RedirectValidationError(`Invalid pattern: ${(error as Error).message}`);
		}
		const slow = options.unchangedPattern ? null : nestedRepeat(source);
		if (slow) throw new RedirectValidationError(`This pattern could make some requests very slow: ${slow}. Write it another way, for example ^/blog/[a-z0-9/-]+$ instead of ^/blog(/[a-z0-9-]+)+$, or (?:[^/]+/)* for any number of path segments.`);
	} else if (!source.startsWith("/") || source.startsWith("//")) {
		throw new RedirectValidationError("The source must be a path starting with /.");
	}
	if (type !== 410) {
		if (!target) throw new RedirectValidationError("Enter a destination.");
		const sitePath = target.startsWith("/") && !target.startsWith("//");
		if (!sitePath && !/^https?:\/\/[^\s]+$/i.test(target)) {
			throw new RedirectValidationError("The destination must be a path starting with / or an http(s) URL.");
		}
		if (!isRegex && sitePath && sourceKey(target.split(/[?#]/)[0]) === sourceKey(source)) {
			throw new RedirectValidationError("A redirect can't point to itself.");
		}
	}
	return {
		source: isRegex ? source : storedSource(source),
		target: type === 410 ? "" : target,
		type,
		isRegex,
		enabled: input.enabled !== false,
		note: input.note?.trim() || null,
	};
}

/**
 * The table is created once per isolate; concurrent first callers share the
 * one batch, for a bounded time (src/core/single-flight.ts), so a first
 * caller whose request was canceled can't hang the admin's later requests.
 */
let tableReady = false;
const creatingTable = sharedSlot<void>();

async function ensureTableOnce(db: D1Database): Promise<void> {
	if (tableReady) return;
	await sharedRead(creatingTable, () => ensureTable(db), { label: "creating the redirects table" });
	tableReady = true;
}

export async function listRules(db: D1Database): Promise<RedirectRule[]> {
	await ensureTableOnce(db);
	const read = () => db.prepare(`SELECT * FROM ${TABLE} ORDER BY is_regex, source`).all<Row>();
	let results: Row[];
	try {
		({ results } = await read());
	} catch (error) {
		// A restore can drop the table after this isolate created it; recreate and retry once.
		if (!isMissingTable(error)) throw error;
		tableReady = false;
		await ensureTableOnce(db);
		({ results } = await read());
	}
	return results.map(toRule);
}

const isMissingTable = (error: unknown) => /no such table/i.test(String((error as Error)?.message ?? error));

type MatchRow = Pick<Row, "id" | "source" | "target" | "type" | "is_regex">;

/**
 * Enabled rules, only the columns matching needs, for the site middleware.
 * Never writes: the table is created by admin writes (saveRule, listRules);
 * until then there are no rules. Read with the pack's other reads of this
 * tick, in one D1 batch.
 */
async function readMatchRules(db: D1Database, statement: D1PreparedStatement): Promise<RedirectRule[]> {
	let results: MatchRow[];
	try {
		results = await batchedAll<MatchRow>(db, statement);
	} catch (error) {
		if (isMissingTable(error)) return [];
		throw error;
	}
	return results.map((r) => ({
		id: r.id,
		source: r.source,
		target: r.target,
		type: r.type as RedirectType,
		isRegex: r.is_regex === 1,
		enabled: true,
		hits: 0,
		lastHit: null,
		note: null,
		createdAt: "",
		updatedAt: "",
	}));
}

const MATCH_COLUMNS = "id, source, target, type, is_regex";

/** The enabled exact rule for a request path, if any: one row through the (source, is_regex) index. */
export async function findExactRule(db: D1Database, pathname: string): Promise<RedirectRule | null> {
	const forms = storedForms(pathname);
	const statement = db
		.prepare(`SELECT ${MATCH_COLUMNS} FROM ${TABLE} WHERE source IN (${forms.map(() => "?").join(", ")}) AND is_regex = 0 AND enabled = 1`)
		.bind(...forms);
	return (await readMatchRules(db, statement))[0] ?? null;
}

/**
 * The sources of the enabled exact rules, at most `max` + 1 of them (more than `max` tells the caller there
 * are too many to keep in memory). Read with the pack's other reads of this tick, in one D1 batch.
 */
export async function loadExactSources(db: D1Database, max: number): Promise<string[]> {
	const statement = db.prepare(`SELECT source FROM ${TABLE} WHERE is_regex = 0 AND enabled = 1 LIMIT ?`).bind(max + 1);
	try {
		return (await batchedAll<{ source: string }>(db, statement)).map((r) => r.source);
	} catch (error) {
		if (isMissingTable(error)) return [];
		throw error;
	}
}

/** The enabled pattern rules, in source order (the order they're tried); read through the patterns index. */
export function loadPatternRules(db: D1Database): Promise<RedirectRule[]> {
	return readMatchRules(db, db.prepare(`SELECT ${MATCH_COLUMNS} FROM ${TABLE} WHERE is_regex = 1 AND enabled = 1 ORDER BY source`));
}

/** Create or update (by id, or by source when importing). Returns the saved rule. */
export async function saveRule(db: D1Database, input: RedirectInput & { id?: string }): Promise<RedirectRule> {
	await ensureTable(db);
	const isRegex = input.isRegex === true;
	const trimmed = (input.source ?? "").trim();
	const forms = isRegex ? [trimmed] : storedForms(trimmed);
	const existing = input.id
		? await db.prepare(`SELECT id, source, is_regex FROM ${TABLE} WHERE id = ?`).bind(input.id).first<{ id: string; source: string; is_regex: number }>()
		: await db
				.prepare(`SELECT id, source, is_regex FROM ${TABLE} WHERE source IN (${forms.map(() => "?").join(", ")}) AND is_regex = ?`)
				.bind(...forms, isRegex ? 1 : 0)
				.first<{ id: string; source: string; is_regex: number }>();
	const rule = validate(input, { unchangedPattern: isRegex && existing?.is_regex === 1 && existing.source === trimmed });
	const now = new Date().toISOString();
	const id = existing?.id ?? input.id ?? crypto.randomUUID();
	if (existing) {
		await db
			.prepare(
				`UPDATE ${TABLE} SET source = ?, target = ?, type = ?, is_regex = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(rule.source, rule.target, rule.type, rule.isRegex ? 1 : 0, rule.enabled ? 1 : 0, rule.note, now, id)
			.run();
	} else {
		await db
			.prepare(
				`INSERT INTO ${TABLE} (id, source, target, type, is_regex, enabled, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(id, rule.source, rule.target, rule.type, rule.isRegex ? 1 : 0, rule.enabled ? 1 : 0, rule.note, now, now)
			.run();
	}
	const saved = await db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).bind(id).first<Row>();
	return toRule(saved!);
}

/** One rule by id, or null (also when the table doesn't exist yet). */
export async function getRule(db: D1Database, id: string): Promise<RedirectRule | null> {
	try {
		const row = await db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).bind(id).first<Row>();
		return row ? toRule(row) : null;
	} catch (error) {
		if (isMissingTable(error)) return null;
		throw error;
	}
}

/** The exact (non-pattern) rule for a path, enabled or not, or null (also when the table doesn't exist yet). */
export async function findExactRuleAny(db: D1Database, pathname: string): Promise<RedirectRule | null> {
	try {
		const forms = storedForms(pathname);
		const row = await db.prepare(`SELECT * FROM ${TABLE} WHERE source IN (${forms.map(() => "?").join(", ")}) AND is_regex = 0`).bind(...forms).first<Row>();
		return row ? toRule(row) : null;
	} catch (error) {
		if (isMissingTable(error)) return null;
		throw error;
	}
}

export async function deleteRule(db: D1Database, id: string): Promise<boolean> {
	await ensureTable(db);
	const result = await db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).bind(id).run();
	return result.meta.changes > 0;
}

// ─── Matching ───────────────────────────────────────────────────────────────

export interface CompiledRules {
	exact: Map<string, RedirectRule>;
	patterns: Array<{ rule: RedirectRule; regex: RegExp }>;
}

export function compile(rules: RedirectRule[]): CompiledRules {
	const exact = new Map<string, RedirectRule>();
	const patterns: CompiledRules["patterns"] = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (rule.isRegex) {
			try {
				patterns.push({ rule, regex: new RegExp(rule.source) });
			} catch {
				// Saved rules are validated; skip anything unparseable rather than fail every request.
			}
		} else {
			exact.set(sourceKey(rule.source), rule);
		}
	}
	return { exact, patterns };
}

const isSitePath = (target: string): boolean => target.startsWith("/") && !target.startsWith("//");

/**
 * A capture group must not move a redirect to another site. A site-relative
 * target collapses leading slashes after substitution (in match), so "/$1" with
 * "/evil.com" stays "/evil.com" rather than becoming "//evil.com". An absolute
 * target whose host is written out must keep that host, so "https://example.com$1"
 * can't become "https://example.com.evil.com/".
 */
function keepsHost(target: string, location: string): boolean {
	// The written-out part of the host: up to the first path, query, fragment, or capture.
	const authority = /^https?:\/\/[^/?#$]*/i.exec(target)?.[0];
	// A host that is (or starts with) a capture, like "https://$1/", is the site owner's choice.
	if (!authority || !authority.slice(authority.indexOf("//") + 2).includes(".")) return true;
	try {
		const fixed = new URL(authority);
		const result = new URL(location);
		return result.protocol === fixed.protocol && result.host === fixed.host;
	} catch {
		return false;
	}
}

export interface Match {
	rule: RedirectRule;
	/** Absolute or site-relative URL; empty for 410. */
	location: string;
}

/**
 * Find the rule for a request path. Exact rules win over patterns; patterns are
 * tried in source order. `$1`…`$9` in a pattern's target are replaced with its
 * capture groups. The request's query string is kept unless the target has one.
 */
export function match(compiled: CompiledRules, pathname: string, search: string): Match | null {
	let rule = compiled.exact.get(sourceKey(pathname));
	let location = rule?.target ?? "";
	if (!rule && pathname.length <= MAX_PATTERN_PATH) {
		for (const candidate of compiled.patterns) {
			const m = pathname.match(candidate.regex);
			if (!m) continue;
			rule = candidate.rule;
			location = rule.target.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "");
			break;
		}
		if (rule && rule.type !== 410) {
			if (isSitePath(rule.target)) location = location.replace(/^[/\\]+/, "/");
			else if (!keepsHost(rule.target, location)) return null;
		}
	}
	if (!rule) return null;
	if (rule.type !== 410 && search) location = withQuery(location, search);
	return { rule, location };
}

/**
 * The request's query string on a redirect target: before the target's
 * fragment (`/#pricing` + `?x=1` → `/?x=1#pricing`, not `/#pricing?x=1`,
 * which loses the query into the anchor), and only when the target has no
 * query of its own. A `?` inside the fragment doesn't count as one.
 */
export function withQuery(location: string, search: string): string {
	const hashAt = location.indexOf("#");
	const base = hashAt === -1 ? location : location.slice(0, hashAt);
	const hash = hashAt === -1 ? "" : location.slice(hashAt);
	if (!search || base.includes("?")) return location;
	return `${base}${search.startsWith("?") ? search : `?${search}`}${hash}`;
}

export async function recordHit(db: D1Database, id: string): Promise<void> {
	await (hitStatement(db, id, 1, new Date().toISOString()) as D1PreparedStatement).run();
}

/** One statement adding `n` hits to a rule (batched per isolate by the site middleware). */
export function hitStatement(db: { prepare(sql: string): { bind(...values: unknown[]): unknown } }, id: string, n: number, now: string): unknown {
	return db.prepare(`UPDATE ${TABLE} SET hits = hits + ?, last_hit = ? WHERE id = ?`).bind(n, now, id);
}

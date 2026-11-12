// Run: node --test test/emdash-contract.test.mjs
//
// Contract tests for the EmDash internals the pack relies on: things EmDash
// doesn't promise to plugins, where a change on EmDash's side would make a pack
// feature stop working without an error (no trash prompt, no guides, a raw
// query that reads nothing). Each test checks the installed EmDash (CI runs
// them against the version the sites run and the latest release), using
// EmDash's shipped dist and types: its real migrations on an in-memory SQLite
// database, its real plugin context, its admin bundle, and Kumo's real markup.
//
// The checklist, and what can't be checked here, is in docs/internals.md
// ("EmDash internals the pack relies on"). Not checked: how EmDash's admin
// behaves in a browser beyond the markup rendered below, Astro's route cache
// object (watchInvalidation), raw writes and revisions, and D1 itself (SQLite
// stands in for it).
import "./ts-resolve.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CompiledQuery, Kysely, sql } from "kysely";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Installed packages ─────────────────────────────────────────

/** The folder of an installed package, found the way Node resolves it (not every package exports ./package.json). */
function packageDir(name, from = root) {
	for (let dir = from; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (safeJson(join(candidate, "package.json"))?.name === name) return candidate;
		if (dirname(dir) === dir) throw new Error(`${name} isn't installed (looked from ${from})`);
	}
}

function safeJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

const pkg = (name, from) => JSON.parse(readFileSync(join(packageDir(name, from), "package.json"), "utf8"));
const emdashDir = packageDir("emdash");
const adminDir = packageDir("@emdash-cms/admin", emdashDir);
const emdashVersion = pkg("emdash").version;
const adminPkg = JSON.parse(readFileSync(join(adminDir, "package.json"), "utf8"));
const packPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** EmDash's dist modules (.mjs), path → source. */
const emdashDist = new Map(
	readdirSync(join(emdashDir, "dist"), { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".mjs"))
		.map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), "utf8")]),
);

/** A function from EmDash's dist that no public entry exports, found by name in its chunk (chunk names are hashed per release). */
async function distFunction(name) {
	for (const [file, src] of emdashDist) {
		if (!src.includes(`function ${name}(`)) continue;
		const exported = src.match(/export \{([^}]*)\};?\s*(?:\/\/# sourceMappingURL=.*)?$/)?.[1] ?? "";
		const entry = exported.split(",").map((s) => s.trim().split(/\s+as\s+/)).find(([local]) => local === name);
		if (!entry) continue;
		return (await import(pathToFileURL(file).href))[entry[1] ?? entry[0]];
	}
	assert.fail(`EmDash ${emdashVersion}'s dist has no exported function ${name}`);
}

/** Every .js file of EmDash's admin bundle, concatenated (about 3 MB). */
function adminBundle() {
	const dist = join(adminDir, "dist");
	return readdirSync(dist, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".js") && !/(^|\/)(locales|messages-)/.test(join(relative(dist, e.parentPath), e.name)))
		.map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
		.join("\n");
}
const admin = adminBundle();

/** Majors a range like "^18.0.0 || ^19.0.0" or "5.90.21" allows; null for "*". */
function majors(range) {
	if (range.trim() === "*") return null;
	return new Set(range.split("||").map((part) => Number(part.trim().replace(/^[\^~>=v]+/, "").split(".")[0])));
}

test("the installed Kumo is the version EmDash's admin pins (the one the sites run)", () => {
	const pin = adminPkg.dependencies["@cloudflare/kumo"];
	const installed = pkg("@cloudflare/kumo").version;
	assert.equal(
		installed,
		pin,
		`@emdash-cms/admin ${adminPkg.version} (EmDash ${emdashVersion}) pins @cloudflare/kumo ${pin}, but ${installed} is installed: set the devDependency to ${pin}. The type check and the Settings page test would otherwise look at a Kumo the sites don't run.`,
	);
});

test("EmDash's admin shares React, React Query and Phosphor with the pack: its versions are in the pack's peer ranges", () => {
	// The pack's admin pages get EmDash's QueryClient (useQueryClient) and render inside its React tree: a second copy breaks both.
	for (const name of ["react", "@tanstack/react-query", "@phosphor-icons/react"]) {
		const wanted = adminPkg.dependencies?.[name] ?? adminPkg.peerDependencies?.[name];
		assert.ok(wanted, `@emdash-cms/admin no longer declares ${name}`);
		const allowed = majors(packPkg.peerDependencies[name]);
		const theirs = [...(majors(wanted) ?? [])];
		assert.ok(!allowed || theirs.every((m) => allowed.has(m)), `@emdash-cms/admin wants ${name} ${wanted}; the pack's peer range is ${packPkg.peerDependencies[name]}`);
	}
});

// ── A database with EmDash's real schema ───────────────────────

const PLUGIN_ID = "coywolf-pack";
let db;
let d1;
let ctx;
let cron;
let manager;

/** A D1Database over the Kysely connection: what the pack's raw SQL runs on, with EmDash's own repositories on the same database. */
function d1Over(kysely) {
	const run = (query, params) =>
		kysely.executeQuery(CompiledQuery.raw(query, params.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v))));
	const statement = (query, params = []) => ({
		bind: (...values) => statement(query, values),
		all: async () => ({ results: (await run(query, params)).rows, success: true, meta: {} }),
		first: async (column) => {
			const row = (await run(query, params)).rows[0] ?? null;
			return column ? (row?.[column] ?? null) : row;
		},
		run: async () => {
			const result = await run(query, params);
			return { success: true, results: result.rows, meta: { changes: Number(result.numAffectedRows ?? 0) } };
		},
		raw: async () => (await run(query, params)).rows.map((row) => Object.values(row)),
	});
	return {
		prepare: (query) => statement(query),
		batch: async (statements) => {
			const out = [];
			for (const s of statements) out.push(await s.all());
			return out;
		},
	};
}

before(async () => {
	// Secret settings need EmDash's encryption key (format: emdash_enc_v1_ + 32 random bytes, base64url).
	process.env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
	const { createDialect } = await import("emdash/db/sqlite");
	const { runMigrations } = await import("emdash/db");
	const { SchemaRegistry, FTSManager, createPluginManager, CronAccessImpl } = await import("emdash");
	db = new Kysely({ dialect: createDialect({ url: ":memory:" }) });
	await runMigrations(db);
	// One collection the way a site has it: SEO, search on title and content (with weights), a URL pattern.
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post", urlPattern: "/{slug}/", hasSeo: true, supports: ["drafts", "revisions", "search", "seo"] });
	await registry.createField("posts", { slug: "title", label: "Title", type: "string", searchable: true });
	await registry.createField("posts", { slug: "content", label: "Content", type: "portableText", searchable: true });
	await new FTSManager(db).enableSearch("posts", { weights: { title: 5, content: 1 } });
	d1 = d1Over(db);

	// A stand-in for the pack registered with EmDash's own plugin manager: its context is the one EmDash builds for plugins.
	const { secretSettingsSchema } = await import("../src/core/secrets.ts");
	manager = createPluginManager({ db });
	manager.register({
		id: PLUGIN_ID,
		version: "0.0.0",
		// redirects:write: what the pack declares for Slug changes (ctx.redirects).
		capabilities: ["redirects:write"],
		storage: { imageVariants: { indexes: [] }, videoStats: { indexes: [] }, videoLikes: { indexes: ["uid"] } },
		admin: { settingsSchema: secretSettingsSchema() },
		hooks: { cron: { handler: async (_event, context) => void (ctx = context) } },
	});
	await manager.activate(PLUGIN_ID);
	await manager.invokeCronHook(PLUGIN_ID, { name: "contract", scheduledAt: new Date().toISOString() });
	assert.ok(ctx, "EmDash's plugin manager didn't hand the plugin a context");
	// The plugin manager's contexts have no cron (EmDash's runtime wires it up): the same class EmDash's runtime uses.
	cron = new CronAccessImpl(db, PLUGIN_ID, () => {}, () => new Date());

	pack = await packStatements();
	const { rows } = await sql`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`.execute(db);
	emdashTables = new Set(rows.map((r) => r.name));
});

after(async () => {
	await db?.destroy();
});

async function columns(table) {
	const { rows } = await sql.raw(`PRAGMA table_info("${table}")`).execute(db);
	return rows;
}

// ── The pack's raw SQL, read from src ─────────────────────────

/** String and template literals of a TypeScript file: { line, endLine, text, parts } (template expressions as ${n}, their source in parts). */
function literals(src) {
	const out = [];
	walk(src, 0, false, out);
	return out;
}

const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await))\s*$/;

/** Walk code from `start`, collecting literals; in a template expression (`inExpr`), stop at the `}` that closes it. */
function walk(src, start, inExpr, out) {
	let depth = 0;
	let i = start;
	let recent = "";
	while (i < src.length) {
		const ch = src[i];
		if (ch === "/" && src[i + 1] === "/") {
			const end = src.indexOf("\n", i);
			i = end === -1 ? src.length : end;
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const end = stringEnd(src, i);
			out.push({ line: lineAt(src, i), endLine: lineAt(src, end), text: src.slice(i + 1, end).replace(/\\(.)/g, "$1"), parts: [] });
			i = end + 1;
			recent = "a";
			continue;
		}
		if (ch === "`") {
			const t = template(src, i, out);
			out.push({ line: lineAt(src, i), endLine: lineAt(src, t.end), text: t.text, parts: t.parts });
			i = t.end + 1;
			recent = "a";
			continue;
		}
		if (ch === "/" && REGEX_AFTER.test(recent)) {
			i = regexEnd(src, i) + 1;
			recent = "a";
			continue;
		}
		if (inExpr) {
			if (ch === "{") depth++;
			else if (ch === "}") {
				if (depth === 0) return i;
				depth--;
			}
		}
		recent = (recent + (/\s/.test(ch) ? " " : ch)).slice(-12);
		i++;
	}
	return i;
}

function lineAt(src, pos) {
	let n = 1;
	for (let i = 0; i < pos; i++) if (src[i] === "\n") n++;
	return n;
}

function stringEnd(src, start) {
	let j = start + 1;
	while (j < src.length && src[j] !== src[start] && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
	return j;
}

function regexEnd(src, start) {
	let inClass = false;
	for (let j = start + 1; j < src.length; j++) {
		const c = src[j];
		if (c === "\\") j++;
		else if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if ((c === "/" && !inClass) || c === "\n") return j;
	}
	return src.length;
}

function template(src, start, out) {
	let text = "";
	const parts = [];
	let i = start + 1;
	while (i < src.length && src[i] !== "`") {
		if (src[i] === "\\") {
			text += src[i + 1];
			i += 2;
		} else if (src[i] === "$" && src[i + 1] === "{") {
			const end = walk(src, i + 2, true, out);
			parts.push(src.slice(i + 2, end).trim());
			text += `\${${parts.length - 1}}`;
			i = end + 1;
		} else text += src[i++];
	}
	return { end: i, text, parts };
}

const SQL_START = /^\s*(\(\s*SELECT\b|SELECT\b|INSERT\s+INTO\b|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b|WITH\b)/;

/** Tables the pack creates itself (not EmDash's). */
const PACK_TABLES = new Set(["coywolf_redirects"]);
/** Files whose SQL works on whatever tables exist (the backup dump and restore copy every table): nothing to check by name. */
const GENERIC_SQL = new Set(["src/backups/dump.ts", "src/backups/restore.ts"]);

/**
 * Values for template expressions that aren't literals in the same file: what
 * the code builds there (see each file), as one value or several to check
 * each. Keyed by "file::expression", or by the expression alone. A new
 * expression fails the test below until it's added here.
 */
const EXPRESSIONS = {
	PLUGIN_ID: "coywolf-pack",
	marks: "?",
	fts: "_emdash_fts_posts",
	// src/images/variants-store.ts
	MIME_LIST: "'image/jpeg','image/png'",
	sum: `(SELECT COUNT(*) FROM "ec_posts" WHERE status = 'published' AND deleted_at IS NULL)`,
	// src/core/content-url.ts: findPublished(by) and primaryTermsQuery(where)
	"src/core/content-url.ts::by": ["slug", "id"],
	"src/core/content-url.ts::where": ["content.id IN (?)", "content.status = 'published' AND content.deleted_at IS NULL"],
	// src/search/title-index.ts: indexEntriesQuery
	"src/search/title-index.ts::title": ['c."title"', "c.title"],
	"src/search/title-index.ts::where": "c.status = 'published' AND c.deleted_at IS NULL AND c.slug IS NOT NULL AND c.locale = ? COLLATE NOCASE",
	// src/search/engine.ts: matchQuery and excerptQuery
	// src/redirects/rules.ts: with two stored forms of a source, the canonical one first
	"canonicalFirst(forms)": ["", " ORDER BY source = ? DESC"],
	"titleExpression(meta)": ['c."title"', "c.title", "NULL"],
	snippet: ["", `, snippet("_emdash_fts_posts", 2, '<mark>', '</mark>', '...', 32) AS snippet`],
	bm25: ['bm25("_emdash_fts_posts")', 'bm25("_emdash_fts_posts", 0, 0, 5, 1)'],
	"src/search/engine.ts::where": `"_emdash_fts_posts" MATCH ? AND c.status = 'published' AND c.deleted_at IS NULL AND c.locale = ? COLLATE NOCASE`,
	"src/search/engine.ts::select": 'c."content" AS f0',
	// src/links/store.ts: refsWhereSql(field)
	field: ["entryKey", "urlId"],
	// src/links/inbound.ts: publishedEntriesSql (the collection's title field, else the slug)
	"src/links/inbound.ts::titleColumn": ['content."title"', "content.slug"],
	// src/schema/module.ts: a media reference by id or storage key
	'ref.by === "id" ? "id" : "storage_key"': ["id", "storage_key"],
};

/** The file's `const NAME = <literal>` declarations: fragments of SQL kept in constants. */
function constants(src, lits) {
	const map = new Map();
	for (const match of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g)) {
		const line = lineAt(src, match.index);
		const next = src[match.index + match[0].length];
		if (!`"'\``.includes(next) && !/^\d/.test(next)) continue;
		if (/^\d/.test(next)) {
			map.set(match[1], { text: src.slice(match.index + match[0].length).match(/^[\d_]+/)[0], parts: [], line, endLine: line });
			continue;
		}
		const lit = lits.find((l) => l.line === line && src.slice(match.index + match[0].length).startsWith(next));
		if (lit) map.set(match[1], lit);
	}
	return map;
}

/** A literal with its expressions filled in: every combination of the values above. Unknown expressions are reported. */
function expand(file, lit, consts, unknown, used, seen = new Set()) {
	let variants = [lit.text];
	used.add(`${file}:${lit.line}-${lit.endLine}`);
	lit.parts.forEach((expr, n) => {
		const marker = `\${${n}}`;
		let values;
		const before = lit.text.slice(0, lit.text.indexOf(marker));
		if (/(?:^|[^\w])(?:ec_|_emdash_fts_)$/.test(before)) values = ["posts"];
		else if (/^[\w.]+\.map\(\(\) => "\?"\)\.join\([^)]*\)$/.test(expr)) values = ["?"];
		else if (`${file}::${expr}` in EXPRESSIONS || expr in EXPRESSIONS) values = [EXPRESSIONS[`${file}::${expr}`] ?? EXPRESSIONS[expr]].flat();
		else if (consts.has(expr) && !seen.has(expr)) values = expand(file, consts.get(expr), consts, unknown, used, new Set([...seen, expr]));
		else if (/^[A-Z][A-Z0-9_]*$/.test(expr) && importedConstant(expr) !== undefined) values = [String(importedConstant(expr))];
		else {
			unknown.push(`${file}:${lit.line}: \${${expr}}`);
			values = ["NULL"];
		}
		variants = variants.flatMap((v) => values.map((value) => v.replace(marker, value)));
	});
	return variants;
}

/** Constants other files export (imported into SQL), read from the modules themselves. */
const IMPORTED = {};
function importedConstant(name) {
	return IMPORTED[name];
}

function sourceFiles() {
	return readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && /\.(ts|mjs)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name))
		.map((e) => relative(root, join(e.parentPath, e.name)));
}

/** Every SQL statement in src that names one of EmDash's tables, with its expressions filled in. */
async function packStatements() {
	Object.assign(IMPORTED, { VARIANTS_COLLECTION: (await import("../src/images/variants-store.ts")).VARIANTS_COLLECTION });
	const statements = [];
	const unknown = [];
	const used = new Set();
	for (const file of sourceFiles()) {
		if (GENERIC_SQL.has(file)) continue;
		const src = readFileSync(join(root, file), "utf8");
		const lits = literals(src);
		const consts = constants(src, lits);
		for (const lit of lits) {
			if (!SQL_START.test(lit.text)) continue;
			for (const text of expand(file, lit, consts, unknown, used)) statements.push({ file, line: lit.line, sql: text.replace(/\s+/g, " ").trim() });
		}
	}
	return { statements, unknown, used };
}

/** Tables a statement reads or writes (table-valued functions and subqueries aside). */
function tablesIn(statement) {
	const read = [...statement.matchAll(/\b(?:FROM|JOIN)\s+(?:"([^"]+)"|([A-Za-z_]\w*)\b(?!\s*\())/gi)];
	const written = [...statement.matchAll(/\b(?:INTO|UPDATE)\s+(?:"([^"]+)"|([A-Za-z_]\w*)\b)/gi)];
	return [...read, ...written].map((m) => m[1] ?? m[2]).filter((t) => t && !/^(SELECT|SET)$/i.test(t));
}

let pack;
let emdashTables;

test("every template expression in the pack's SQL has a known value (add new ones to EXPRESSIONS)", () => {
	assert.deepEqual(pack.unknown, []);
	assert.ok(pack.statements.length > 60, `found only ${pack.statements.length} statements`);
});

test("the pack's SQL prepares against EmDash's tables and columns", async () => {
	const failures = [];
	let checked = 0;
	for (const s of pack.statements) {
		const tables = tablesIn(s.sql);
		if (!tables.some((t) => !PACK_TABLES.has(t))) continue; // only the pack's own tables (or none: a SPARQL query)
		checked++;
		const missing = tables.filter((t) => !PACK_TABLES.has(t) && !emdashTables.has(t) && t !== "sqlite_master");
		if (missing.length) {
			failures.push(`${s.file}:${s.line}: no table ${missing.join(", ")} in EmDash ${emdashVersion}\n    ${s.sql}`);
			continue;
		}
		try {
			// A subquery kept in a variable ("(SELECT …)") is checked as a column of a SELECT.
			await sql.raw(`EXPLAIN ${s.sql.startsWith("(") ? `SELECT ${s.sql}` : s.sql}`).execute(db);
		} catch (error) {
			failures.push(`${s.file}:${s.line}: ${error.message}\n    ${s.sql}`);
		}
	}
	assert.ok(checked > 60, `checked only ${checked} statements`);
	assert.deepEqual(failures, [], `The pack's SQL doesn't match EmDash ${emdashVersion}'s schema:\n${failures.join("\n")}`);
});

test("the pack's INSERTs into EmDash's tables name every column EmDash requires", async () => {
	const failures = [];
	for (const s of pack.statements) {
		const match = /^INSERT\s+INTO\s+"?([\w]+)"?\s*\(([^)]*)\)/i.exec(s.sql);
		if (!match || PACK_TABLES.has(match[1])) continue;
		const named = new Set(match[2].split(",").map((c) => c.trim().replace(/"/g, "")));
		const required = (await columns(match[1])).filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => c.name);
		const pk = (await columns(match[1])).filter((c) => c.pk).map((c) => c.name);
		const missing = [...required, ...pk].filter((c) => !named.has(c));
		if (missing.length) failures.push(`${s.file}:${s.line}: ${match[1]} also needs ${missing.join(", ")}\n    ${s.sql}`);
	}
	assert.deepEqual(failures, [], failures.join("\n"));
});

test("every line of src that names one of EmDash's tables in SQL was checked above", () => {
	const TABLE_SQL = /\b(?:FROM|JOIN|INTO|UPDATE)\s+["'`]?(options|media|_plugin_storage|_emdash_\w+|taxonomies|content_taxonomies|ec_)/;
	const missed = [];
	const usedLines = [...pack.used].map((key) => {
		const [file, range] = key.split(/:(?=\d+-\d+$)/);
		const [from, to] = range.split("-").map(Number);
		return { file, from, to };
	});
	for (const file of sourceFiles()) {
		if (GENERIC_SQL.has(file)) continue;
		readFileSync(join(root, file), "utf8")
			.split("\n")
			.forEach((text, i) => {
				const line = i + 1;
				if (/^\s*(\*|\/\/|\/\*)/.test(text) || !TABLE_SQL.test(text)) return;
				if (!usedLines.some((u) => u.file === file && line >= u.from && line <= u.to)) missed.push(`${file}:${line}: ${text.trim()}`);
			});
	}
	assert.deepEqual(missed, [], `SQL the scanner didn't pick up (a string it can't read, or built some other way): check it by hand or make it a literal:\n${missed.join("\n")}`);
});

test("EmDash's FTS tables: id and locale, then the searchable fields (the pack's bm25 weights and snippet column count on it)", async () => {
	// src/search/engine.ts matchQuery: weights "0, 0, <field weights…>" and snippet(…, 2, …) for the first searchable field.
	const names = (await columns("_emdash_fts_posts")).map((c) => c.name);
	assert.deepEqual(names, ["id", "locale", "title", "content"]);
	const { rows } = await sql`SELECT f.slug FROM _emdash_fields f JOIN _emdash_collections c ON c.id = f.collection_id WHERE c.slug = 'posts' AND f.searchable = 1 ORDER BY f.rowid`.execute(db);
	assert.deepEqual(rows.map((r) => r.slug), names.slice(2), "the FTS columns follow the fields in META_FIELDS_SQL's order");
});

test("search_config is the JSON the pack's parseSearchConfig reads, the way EmDash's getSearchConfig does", async () => {
	const { FTSManager } = await import("emdash");
	const { parseSearchConfig } = await import("../src/search/engine.ts");
	const { rows } = await sql`SELECT search_config FROM _emdash_collections WHERE slug = 'posts'`.execute(db);
	const theirs = await new FTSManager(db).getSearchConfig("posts");
	const ours = parseSearchConfig(rows[0].search_config);
	assert.equal(ours.enabled, theirs.enabled);
	assert.deepEqual(ours.weights, theirs.weights);
});

test("live search finds a published entry through EmDash's FTS triggers, with its URL", async () => {
	const { ContentRepository } = await import("emdash");
	const { liveSearchD1, invalidateSearchMeta } = await import("../src/search/engine.ts");
	await new ContentRepository(db).create({ type: "posts", slug: "coyote-tracks", status: "published", publishedAt: "2026-01-02T03:04:05.000Z", data: { title: "Coyote tracks in the snow" } });
	await new ContentRepository(db).create({ type: "posts", slug: "coyote-draft", status: "draft", data: { title: "Coyote draft" } });
	invalidateSearchMeta();
	const result = await liveSearchD1(d1, "coyote", { database: "contract" });
	assert.deepEqual(result.items.map((i) => i.title), ["Coyote tracks in the snow"], "the published entry, not the draft");
	assert.match(result.items[0].url, /^\/coyote-tracks\/?$/, "its URL, from the collection's pattern");
});

// ── Plugin storage, KV, settings and cron ──────────────────────

async function option(name) {
	const { rows } = await sql`SELECT value, revision FROM options WHERE name = ${name}`.execute(db);
	return rows[0] ?? null;
}

test("ctx.kv and ctx.settings rows are plugin:<id>:<key> and plugin:<id>:settings:<key> with JSON values (what the pack's raw SQL reads and writes)", async () => {
	await ctx.kv.set("pageCache:contract", { a: 1 });
	assert.deepEqual(JSON.parse((await option("plugin:coywolf-pack:pageCache:contract")).value), { a: 1 });
	await ctx.settings.set("contractSetting", { b: 2 });
	assert.deepEqual(JSON.parse((await option("plugin:coywolf-pack:settings:contractSetting")).value), { b: 2 });
	// ctx.kv's "settings:" keys are the same rows as ctx.settings.
	assert.deepEqual(await ctx.kv.get("settings:contractSetting"), { b: 2 });

	// The pack's raw reads see what EmDash wrote: the feature switches (src/core/features.ts) and a registered setting.
	const { registerFeatures, siteFeatures, readSiteSetting, invalidateFeatures, GENERATION_OPTION } = await import("../src/core/features.ts");
	registerFeatures([{ id: "contractFeature", label: "Contract", description: "", default: false }]);
	await ctx.settings.set("features", { contractFeature: true });
	invalidateFeatures();
	assert.equal((await siteFeatures(d1, true)).contractFeature, true);
	assert.deepEqual(await readSiteSetting("contractSetting", d1), { value: { b: 2 } });

	// And EmDash reads what the pack writes raw: the settings generation (src/core/generation.ts).
	const { recordSettingsChange } = await import("../src/core/generation.ts");
	const row = await recordSettingsChange(d1, null);
	assert.equal(GENERATION_OPTION, "plugin:coywolf-pack:state:settingsGeneration");
	assert.deepEqual(await ctx.kv.get("state:settingsGeneration"), row);
	assert.ok((await ctx.kv.getVersioned("state:settingsGeneration")).revision, "a raw insert gets EmDash's default revision");
});

test("ctx.kv.list(prefix): keys without the plugin prefix, only under the prefix, LIKE characters taken literally", async () => {
	await ctx.kv.set("contractList:a", 1);
	await ctx.kv.set("contractList:b", 2);
	await ctx.kv.set("contractListX", 3);
	await ctx.kv.set("contract_ist:c", 4); // "_" is a LIKE wildcard: must not match "contractList:"
	const rows = await ctx.kv.list("contractList:");
	assert.deepEqual(rows.sort((a, b) => a.key.localeCompare(b.key)), [
		{ key: "contractList:a", value: 1 },
		{ key: "contractList:b", value: 2 },
	]);
	// settings.list("schema") (src/schema/module.ts) lists only settings under that prefix.
	await ctx.settings.set("schemaContract", "x");
	assert.deepEqual(await ctx.settings.list("schemaContract"), [{ key: "schemaContract", value: "x" }]);
});

test("compareAndSet: null creates only when absent, a revision replaces only that revision, and the result is { applied, revision }", async () => {
	// ctx.kv (videos salt, AI usage and lock, links lease), ctx.settings (robots import) and storage collections (likes, video stats).
	const stores = {
		kv: ctx.kv,
		settings: ctx.settings,
		storage: ctx.storage.videoLikes,
	};
	for (const [name, store] of Object.entries(stores)) {
		const key = `contractCas${name}`;
		const created = await store.compareAndSet(key, null, { n: 1 });
		assert.equal(created.applied, true, name);
		assert.equal(typeof created.revision, "string", name);
		assert.deepEqual(await store.compareAndSet(key, null, { n: 2 }), { applied: false }, `${name}: null when present`);
		const current = await store.getVersioned(key);
		assert.deepEqual(current.value, { n: 1 }, name);
		assert.equal(current.revision, created.revision, name);
		assert.equal((await store.compareAndSet(key, current.revision, { n: 3 })).applied, true, name);
		assert.equal((await store.compareAndSet(key, current.revision, { n: 4 })).applied, false, `${name}: stale revision`);
		const latest = await store.getVersioned(key);
		assert.deepEqual(latest.value, { n: 3 }, name);
		assert.deepEqual(await store.compareAndDelete(key, created.revision), { applied: false }, `${name}: stale delete`);
		assert.deepEqual(await store.compareAndDelete(key, latest.revision), { applied: true }, `${name}: delete`);
		assert.equal(await store.getVersioned(key), null, `${name}: deleted`);
	}
});

test("storage updateIf applies a counter delta when its where matches (video plays and likes)", async () => {
	const stats = ctx.storage.videoStats;
	await stats.put("v1", { plays: 1, likes: 0 });
	const r = await stats.updateIf("v1", { where: {}, delta: { plays: { inc: 1 } } });
	assert.equal(r.applied, true);
	assert.equal(r.data.plays, 2);
	const none = await stats.updateIf("v1", { where: { likes: { gte: 1 } }, delta: { likes: { dec: 1 } } });
	assert.equal(none.applied, false);
	assert.equal((await stats.updateIf("missing", { where: {}, delta: { plays: { inc: 1 } } })).applied, false, "a missing document isn't created");
});

test("rows the pack writes straight into _plugin_storage are valid EmDash storage documents", async () => {
	const { writeVariantRecord, addCrops, hasCurrentVariants } = await import("../src/images/variants-store.ts");
	const { VARIANTS_VERSION } = await import("../src/images/variants.ts");
	const doc = { v: VARIANTS_VERSION, w: [320, 640], c: [] };
	await writeVariantRecord(d1, "media1", doc);
	assert.deepEqual(await ctx.storage.imageVariants.get("media1"), doc);
	const versioned = await ctx.storage.imageVariants.getVersioned("media1");
	assert.ok(versioned.revision);
	assert.equal(await addCrops(d1, "media1", ["400x300"]), true);
	assert.deepEqual((await ctx.storage.imageVariants.get("media1")).c, ["400x300"]);
	assert.equal(await hasCurrentVariants(d1, "media1"), true);
	// EmDash's compare-and-set sees the pack's raw writes as new revisions.
	assert.equal((await ctx.storage.imageVariants.compareAndSet("media1", versioned.revision, doc)).applied, false);
});

test("ctx.email and ctx.users: no ctx.email until a provider is selected, then send() reaches it from the pack; admins are role 50 (src/alerts)", async () => {
	const { createHookPipeline, definePlugin, UserRepository } = await import("emdash");
	const EmailPipeline = await distClass("EmailPipeline", "new EmailNotConfiguredError()");
	const delivered = [];
	const provider = definePlugin({
		id: "contract-email-provider",
		version: "0.0.0",
		capabilities: ["hooks.email-transport:register"],
		hooks: { "email:deliver": { exclusive: true, handler: async (event) => void delivered.push(event) } },
	});
	let packCtx;
	const pack = definePlugin({
		id: PLUGIN_ID,
		version: "0.0.0",
		// What the Alerts module declares (src/alerts/pack.ts).
		capabilities: ["email:send", "users:read"],
		hooks: { cron: { handler: async (_event, context) => void (packCtx = context) } },
	});
	const pipeline = createHookPipeline([provider, pack], { db });
	pipeline.setContextFactory({ emailPipeline: new EmailPipeline(pipeline) });
	const tick = () => pipeline.invokeCronHook(PLUGIN_ID, { name: "contract", scheduledAt: new Date().toISOString() });

	// No provider selected (Settings → Email): the Alerts page shows the setup steps.
	await tick();
	assert.equal(packCtx.email, undefined, "ctx.email exists without a selected provider: Alerts would think email is set up");
	assert.deepEqual(pipeline.getExclusiveHookProviders("email:deliver").map((p) => p.pluginId), ["contract-email-provider"]);

	pipeline.setExclusiveSelection("email:deliver", "contract-email-provider");
	await tick();
	assert.equal(typeof packCtx.email?.send, "function");
	await packCtx.email.send({ to: "owner@example.com", subject: "Example: Backup failed", text: "Plain text", html: "<p>HTML</p>" });
	assert.equal(delivered.length, 1);
	assert.deepEqual(delivered[0].message, { to: "owner@example.com", subject: "Example: Backup failed", text: "Plain text", html: "<p>HTML</p>" });
	assert.equal(delivered[0].source, PLUGIN_ID, "plugin email goes out with the plugin's id as its source");

	// ctx.users.list({ role: 50 }): the site's admins, the default recipients.
	const users = new UserRepository(db);
	await users.create({ email: "admin@example.com", name: "Admin", role: 50 });
	await users.create({ email: "editor@example.com", name: "Editor", role: 40 });
	const { items } = await packCtx.users.list({ role: 50, limit: 50 });
	assert.deepEqual(items.map((u) => u.email), ["admin@example.com"]);
	assert.deepEqual(Object.keys(items[0]).sort(), ["createdAt", "email", "id", "name", "role"]);
});

test("ctx.cron: schedule, list and cancel by name", async () => {
	await cron.schedule("contract-task", { schedule: "@daily" });
	assert.deepEqual((await cron.list()).map((t) => [t.name, t.schedule]), [["contract-task", "@daily"]]);
	await cron.cancel("contract-task");
	assert.deepEqual(await cron.list(), []);
	await assert.doesNotReject(cron.cancel("never-scheduled"), "cancelling a task that isn't there (src/discovery/module.ts) is fine");
});

/** A class from EmDash's dist that no public entry exports, found by a line only it has. */
async function distClass(name, marker) {
	for (const [file, src] of emdashDist) {
		if (!src.includes(marker) || !src.includes(`var ${name} = class`)) continue;
		const exported = src.match(/export \{([^}]*)\};?\s*(?:\/\/# sourceMappingURL=.*)?$/)?.[1] ?? "";
		const entry = exported.split(",").map((s) => s.trim().split(/\s+as\s+/)).find(([local]) => local === name);
		if (entry) return (await import(pathToFileURL(file).href))[entry[1] ?? entry[0]];
		// Since 1.5.0 some classes (EmailPipeline) live only inside a chunk that doesn't export them and that
		// can't load outside Astro (it imports virtual: modules). Load the class's own source region instead.
		return (await import(regionModule(file, src, name)))[name];
	}
	assert.fail(`EmDash ${emdashVersion}'s dist has no class ${name} with ${marker}`);
}

/**
 * A file URL for a module made of the bundler region (`//#region` … `//#endregion`) of `src` that declares `local`,
 * exporting it. Only for self-contained regions: Node builtins are the one import it adds. Removed after the tests.
 */
function regionModule(file, src, local) {
	const at = src.indexOf(`var ${local} = class`);
	const from = src.lastIndexOf("//#region", at);
	const to = src.indexOf("//#endregion", at);
	assert.ok(from !== -1 && to !== -1, `${local} in ${relative(emdashDir, file)} is not inside a //#region`);
	const region = src.slice(from, to);
	const builtins = ["AsyncLocalStorage"].filter((n) => new RegExp(`\\b${n}\\b`).test(region));
	const dir = mkdtempSync(join(tmpdir(), "coywolf-contract-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const out = join(dir, `${local}.mjs`);
	const head = builtins.length ? `import { ${builtins.join(", ")} } from "node:async_hooks";\n` : "";
	writeFileSync(out, `${head}${region}\nexport { ${local} };\n`);
	return pathToFileURL(out).href;
}

test("the Redirect Manager normalizes exact sources the way EmDash's redirects do (src/redirects/rules.ts sourceKey)", async () => {
	const normalizeSourcePath = await distFunction("normalizeSourcePath");
	const { sourceKey } = await import("../src/redirects/rules.ts");
	for (const sample of ["/café", "/caf%C3%A9", "/caf%c3%a9", "/a b", "/日本語/パス", "/%E2%82%AC", "/bad%zz", "/x?y=1", "/plain", "/"]) {
		assert.equal(sourceKey(sample), normalizeSourcePath(sample), sample);
	}
	// EmDash keeps a trailing slash in the source; the pack matches with or without one, so it drops it.
	assert.equal(sourceKey("/café/"), normalizeSourcePath("/café/").replace(/\/$/, ""));
});

test("ctx.redirects (redirects:write): Slug changes delete EmDash's own slug-change redirect through it, matched by auto, group, source and destination (src/redirects/slug-changes.ts)", async () => {
	const { dropEmDashAuto, EMDASH_AUTO_GROUP } = await import("../src/redirects/slug-changes.ts");
	const { redirectsPack } = await import("../src/redirects/pack.ts");
	assert.ok(redirectsPack({}).capabilities.includes("redirects:write"), "the Redirect Manager module no longer declares redirects:write");
	assert.equal(typeof ctx.redirects?.delete, "function", "EmDash gives a plugin with redirects:write no ctx.redirects.delete");
	// EmDash's own slug-change redirect, written the way its content update writes it (posts' pattern is /{slug}/).
	const RedirectRepository = await distClass("RedirectRepository", "async createAutoRedirect(");
	const repo = new RedirectRepository(db);
	const auto = await repo.createAutoRedirect("posts", "old-name", "new-name", "c1", "/{slug}/", null, null);
	assert.equal(auto.groupName, EMDASH_AUTO_GROUP, "EmDash files its slug-change redirects under another group now");
	assert.equal(auto.auto, true);
	const unrelated = await repo.createAutoRedirect("posts", "keep-me", "elsewhere", "c2", "/{slug}/", null, null);
	const handMade = await ctx.redirects.create({ source: "/posts/old-name", destination: "/new-name/" });
	// Listing by auto and group, narrowed by search, finds it; get gives the revision delete wants.
	const listed = await ctx.redirects.list({ auto: true, group: EMDASH_AUTO_GROUP, search: "new-name", limit: 100 });
	assert.deepEqual(listed.items.map((r) => r.id), [auto.id]);
	assert.equal(typeof (await ctx.redirects.get(auto.id))._rev, "string");

	assert.equal(await dropEmDashAuto(ctx, "posts", "/old-name/", "new-name"), 1);
	assert.equal(await ctx.redirects.get(auto.id), null, "EmDash's row for the change is gone");
	assert.ok(await ctx.redirects.get(unrelated.id), "another change's row stays");
	assert.ok(await ctx.redirects.get(handMade.redirect.id), "a hand-made redirect stays, even from a matching path");
	assert.equal(await dropEmDashAuto(ctx, "posts", "/old-name/", "new-name"), 0, "nothing left to delete");

	// A revision read before a change is refused: the pack leaves a row someone changed meanwhile.
	const later = await repo.createAutoRedirect("posts", "first", "second", "c3", "/{slug}/", null, null);
	const read = await ctx.redirects.get(later.id);
	await ctx.redirects.update(later.id, { enabled: false, _rev: read._rev });
	await assert.rejects(ctx.redirects.delete(later.id, { _rev: read._rev }));
	for (const id of [unrelated.id, handMade.redirect.id, later.id]) {
		const current = await ctx.redirects.get(id);
		await ctx.redirects.delete(id, { _rev: current._rev });
	}
});

test("secret settings: encrypted at rest, decrypted for a declared secret, refused for an undeclared one (src/core/secrets.ts)", async () => {
	const emdash = await import("emdash");
	// EmDash's Settings page API handlers (emdash/internal/plugin-test-runtime exports them, but it loads Astro's virtual modules).
	const handlePluginSettingsGet = await distFunction("handlePluginSettingsGet");
	const handlePluginSettingsUpdate = await distFunction("handlePluginSettingsUpdate");
	const { SECRET_SETTINGS, secretSettingsSchema } = await import("../src/core/secrets.ts");

	await ctx.settings.set("aiApiKey", "sk-contract");
	const stored = JSON.parse((await option("plugin:coywolf-pack:settings:aiApiKey")).value);
	assert.equal(emdash.isEncryptedPluginSetting(stored), true, "a declared secret is stored encrypted (so the pack's raw SQL must never read one)");
	assert.equal(await ctx.settings.get("aiApiKey"), "sk-contract");

	// Read without the key in the schema (a secret removed from SECRET_SETTINGS while its value is stored): EmDash throws.
	const { OptionsRepository, createSettingsAccess, PluginSettingEncryptionError } = emdash;
	const withoutIt = createSettingsAccess(new OptionsRepository(db), PLUGIN_ID, {});
	await assert.rejects(withoutIt.get("aiApiKey"), PluginSettingEncryptionError);
	await assert.rejects(withoutIt.list("ai"), PluginSettingEncryptionError, "list decodes every value under the prefix");

	// So the pack lists settings only under "schema", which no secret (current or retired) starts with.
	for (const key of [...Object.keys(SECRET_SETTINGS), "discoveryIndexnowKey", "discoveryBingApiKey"]) assert.ok(!key.startsWith("schema"), key);

	// EmDash's Settings page (GET and save) with the pack's schema: labels as declared (the guides script looks fields up by label),
	// secrets reported as set, never returned, and a save there is what ctx.settings reads.
	const schema = secretSettingsSchema();
	const got = await handlePluginSettingsGet(db, PLUGIN_ID, schema);
	assert.equal(got.success, true, JSON.stringify(got.error));
	for (const [key, field] of Object.entries(SECRET_SETTINGS)) assert.equal(got.data.schema[key].label, field.label);
	assert.equal(got.data.secretsSet.aiApiKey, true);
	assert.ok(!JSON.stringify(got.data).includes("sk-contract"));
	const saved = await handlePluginSettingsUpdate(db, PLUGIN_ID, schema, { videosApiToken: "cf-contract" });
	assert.equal(saved.success, true, JSON.stringify(saved.error));
	assert.equal(await ctx.settings.get("videosApiToken"), "cf-contract");
});

test("definePlugin keeps admin.pages and admin.widgets as getters, and the manifest reads them per build", async () => {
	// src/index.ts liveAdmin: modules switched off drop out of the sidebar without a deploy.
	const { definePlugin } = await import("emdash");
	let reads = 0;
	const adminDef = Object.defineProperties(
		{ entry: "@coywolf/emdash/admin" },
		{
			pages: { enumerable: true, get: () => (reads++, [{ path: `/p${reads}`, label: "P" }]) },
			widgets: { enumerable: true, get: () => [] },
		},
	);
	const resolved = definePlugin({ id: "contract-live-admin", version: "0.0.0", admin: adminDef });
	const first = resolved.admin.pages[0].path;
	const second = resolved.admin.pages[0].path;
	assert.notEqual(first, second, "definePlugin copied admin.pages instead of keeping the getter");
	// EmDash's runtime builds the manifest from plugin.admin.pages on each (request-cached) build.
	const runtime = [...emdashDist.values()].find((src) => src.includes("_buildManifest()"));
	assert.ok(runtime, "EmDash's runtime no longer has _buildManifest");
	assert.match(runtime, /requestCached\("emdash:manifest", \(\) => this\._buildManifest\(\)\)/);
	assert.match(runtime, /adminPages: plugin\.admin\?\.pages \?\? \[\]/);
	assert.match(runtime, /dashboardWidgets: plugin\.admin\?\.widgets \?\? \[\]/);
});

// ── Storage publicUrl (the media host) ────────────────────────

test("EmDash's storage publicUrl reaches the pack through virtual:emdash/config, and EmDash's media URLs are <publicUrl>/<key> (src/images/settings.ts, src/images/lib.ts)", async () => {
	// The build-time config module is the serializable config as JSON, with storage as the site configured it.
	const astro = [...emdashDist.values()].find((src) => src.includes("function buildSerializableConfig("));
	assert.ok(astro, `EmDash ${emdashVersion} no longer builds a serializable config`);
	assert.match(functionSource(astro, "buildSerializableConfig"), /storage: resolvedConfig\.storage,/);
	const virtual = [...emdashDist.values()].find((src) => src.includes("function generateConfigModule("));
	assert.ok(virtual, "no generateConfigModule");
	assert.match(functionSource(virtual, "generateConfigModule"), /return `export default \$\{JSON\.stringify\(serializableConfig\)\};`/);
	assert.match(virtual, /const VIRTUAL_CONFIG_ID = "virtual:emdash\/config";/);
	// A storage adapter's config keeps publicUrl (EmDash's S3 adapter; @emdash-cms/cloudflare's r2() passes it the same way), and a
	// stored key's public URL is publicUrl, trailing slashes removed, then /<key>.
	const s3 = [...emdashDist.entries()].find(([file]) => file.endsWith(join("storage", "s3.mjs")))?.[1];
	assert.ok(s3, "no storage/s3.mjs");
	assert.match(s3, /getPublicUrl\(key\) \{\s*if \(this\.publicUrl\) return `\$\{this\.publicUrl\.replace\(TRAILING_SLASH_PATTERN, ""\)\}\/\$\{key\}`;/);
	// What EmDash's components call (Astro.locals.emdash.getPublicMediaUrl): the storage adapter's getPublicUrl.
	const resolver = await distFunction("createPublicMediaUrlResolver");
	const resolveUrl = (storage, key) => resolver(storage)(key);
	assert.equal(resolveUrl({ getPublicUrl: (key) => `https://media.example.com/${key}` }, "01ABC.jpg"), "https://media.example.com/01ABC.jpg");
	assert.equal(resolveUrl(undefined, "01ABC.jpg"), "/_emdash/api/media/file/01ABC.jpg");
	// The pack reads that config and recognizes both forms.
	const { loadStoragePublicUrl, resetStoragePublicUrl } = await import("../src/images/settings.ts");
	const { imageCdn, mediaFile } = await import("../src/images/lib.ts");
	resetStoragePublicUrl();
	await loadStoragePublicUrl(async () => JSON.parse(JSON.stringify({ storage: { entrypoint: "@emdash-cms/cloudflare/storage/r2", config: { binding: "MEDIA", publicUrl: "https://media.example.com/" } } })));
	try {
		assert.equal(imageCdn(), "https://media.example.com");
		assert.deepEqual(mediaFile("https://media.example.com/01ABC.jpg"), { id: "01ABC", ext: "jpg" });
		assert.deepEqual(mediaFile(resolveUrl(undefined, "01ABC.jpg")), { id: "01ABC", ext: "jpg" });
	} finally {
		resetStoragePublicUrl();
	}
});

// ── page:metadata ──────────────────────────────────────────────

test("page:metadata: EmDash accepts the pack's contributions, and the pack's primary graph and robots replace core's", async () => {
	const { createPublicPageContext, generateBaseSeoContributions, generateSiteSeoContributions, resolvePageMetadata } = await import("emdash/page");
	// The pack's recorded output for a full article page (test/schema-metadata.test.mjs keeps it current).
	const ours = JSON.parse(readFileSync(join(root, "test/fixtures/schema-metadata.json"), "utf8"));
	const page = createPublicPageContext({
		url: "https://example.com/my-post/",
		locale: "en-US",
		kind: "content",
		title: "My Post | Example",
		description: "About my post.",
		canonical: "https://example.com/my-post/",
		image: "https://cdn.example/cover.jpg",
		content: { collection: "posts", id: "e1", slug: "my-post" },
		siteName: "Example",
	});
	const core = [...generateSiteSeoContributions({}), ...generateBaseSeoContributions(page)];
	assert.ok(core.some((c) => c.kind === "jsonld" && c.id === "primary"), "core's JSON-LD is no longer id \"primary\": the pack's graph would be added next to it, not replace it");
	// EmDashHead's order: plugin contributions first (first wins).
	const resolved = resolvePageMetadata([...ours, ...core]);
	const primary = resolved.jsonld.filter((j) => j.id === "primary");
	assert.equal(primary.length, 1);
	assert.deepEqual(JSON.parse(primary[0].json), ours.find((c) => c.kind === "jsonld").graph);
	for (const c of ours) {
		if (c.kind === "meta") assert.deepEqual(resolved.meta.find((m) => m.name === c.name), { name: c.name, content: c.content });
		else if (c.kind === "property") assert.deepEqual(resolved.properties.find((p) => p.property === c.property), { property: c.property, content: c.content });
		else if (c.kind !== "jsonld") assert.fail(`a contribution kind the test doesn't know: ${c.kind}`);
	}
	// EmDashHead ships as source (the site's build compiles it): plugin contributions go first, and the page the hooks
	// get keeps the theme's extra keys (coywolf.entry, coywolf.videos…), since the SEO panel overlay spreads it.
	const head = readFileSync(join(emdashDir, "src/components/EmDashHead.astro"), "utf8");
	assert.match(head, /runtime\.collectPageMetadata\(resolvedPage\)/);
	// 1.5.0 puts the staging noindex first (only while staging), so a staging site stays noindex whatever the pack says.
	assert.match(head, /\[\s*(?:\.\.\.stagingContributions,\s*)?\.\.\.pluginContributions,\s*\.\.\.siteContributions,\s*\.\.\.baseContributions,/);
	const overlay = functionSource(readFileSync(join(emdashDir, "src/page/seo-contributions.ts"), "utf8"), "applySeoPanelToPageContext");
	assert.match(overlay, /return \{\s*\.\.\.page,/, overlay);
});

// ── Admin patches ──────────────────────────────────────────────

/** The source of a function in a bundle, from `function name(` to its closing brace. */
function functionSource(src, name) {
	const at = src.indexOf(`function ${name}(`);
	assert.ok(at !== -1, `function ${name} isn't in the bundle`);
	const open = src.indexOf("{", src.indexOf(")", at));
	return src.slice(at, walk(src, open + 1, true, []) + 1);
}

/** EmDash's injected routes: pattern → route file (from the integration's injectRoute calls). */
function emdashRoutes() {
	const src = readFileSync(join(emdashDir, "dist/astro/index.mjs"), "utf8");
	return new Map([...src.matchAll(/injectRoute\(\{\s*pattern: "([^"]+)",\s*entrypoint: resolveRoute\("([^"]+)"\)/g)].map((m) => [m[1], m[2]]));
}

/** The HTTP methods a route file exports (from its .d.mts). */
function routeMethods(route) {
	const file = join(emdashDir, "dist/astro/routes", `${route.replace(/\.ts$/, "").replaceAll("[", "_").replaceAll("]", "_")}.d.mts`);
	const exported = readFileSync(file, "utf8").match(/export \{([^}]*)\}/)?.[1] ?? "";
	return new Set(exported.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()));
}

test("EmDash's routes the pack calls, links to or watches exist, with those methods", () => {
	const routes = emdashRoutes();
	const needed = {
		"/_emdash/api/settings": ["POST"], // middleware: SEO and staging saves
		"/_emdash/api/manifest": ["GET"], // middleware: fresh switches for the sidebar
		"/_emdash/api/content/[collection]/[id]": ["DELETE"], // trash prompt: move to trash
		"/_emdash/api/content/[collection]/[id]/unpublish": ["POST"], // trash prompt: unpublish
		"/_emdash/api/media/[id]": ["DELETE"], // stored image sizes follow media deletes
		"/_emdash/api/media/[id]/replace": ["PUT"], // …and replaced files (src/images/pack.ts variantsAfterMediaWrite)
		"/_emdash/api/media/file/[...key]": ["GET"], // media URLs
		"/_emdash/api/plugins/[pluginId]/[...path]": ["GET", "POST"], // the pack's routes
		"/_emdash/api/search": ["GET"],
		"/_emdash/api/search/suggest": ["GET"],
		"/_emdash/admin/[...path]": [],
	};
	for (const [pattern, methods] of Object.entries(needed)) {
		assert.ok(routes.has(pattern), `EmDash ${emdashVersion} no longer injects ${pattern}`);
		if (!methods.length) continue;
		const exported = routeMethods(routes.get(pattern));
		for (const m of methods) assert.ok(exported.has(m) || exported.has("ALL"), `${pattern} doesn't export ${m} (exports ${[...exported].join(", ")})`);
	}
});

test("trash prompt: the admin's content calls go through the global fetch, with the URL and method the prompt watches", async () => {
	const { removalFromRequest } = await import("../src/admin/trash-prompt-core.ts");
	// src/admin/trash-prompt-core.ts wraps window.fetch: the admin must look fetch up when it calls, not keep its own reference.
	const apiFetch = functionSource(admin, "apiFetch");
	assert.match(apiFetch, /(?<![\w$.])fetch\(/, `EmDash's apiFetch no longer calls the global fetch:\n${apiFetch}`);
	assert.match(admin, /const API_BASE = "\/_emdash\/api";/);
	const del = functionSource(admin, "deleteContent");
	assert.match(del, /apiFetch\(`\$\{API_BASE\}\/content\/\$\{collection\}\/\$\{id\}(?:`|\$\{params)/, del);
	assert.match(del, /method: "DELETE"/, del);
	const unpublish = functionSource(admin, "unpublishContent");
	assert.match(unpublish, /apiFetch\(`\$\{API_BASE\}\/content\/\$\{collection\}\/\$\{id\}\/unpublish(?:`|\$\{params)/, unpublish);
	assert.match(unpublish, /method: "POST"/, unpublish);
	// What those calls look like, with the locale query EmDash adds.
	assert.deepEqual(removalFromRequest("DELETE", "/_emdash/api/content/posts/01JABC?locale=en"), { id: "posts:01JABC", reason: "deleted" });
	assert.deepEqual(removalFromRequest("POST", "/_emdash/api/content/posts/01JABC/unpublish?locale=en"), { id: "posts:01JABC", reason: "unpublished" });
});

test('the admin\'s manifest query key is ["manifest"] (the Features page refreshes the sidebar with it)', () => {
	assert.match(admin, /queryKey: \["manifest"\],\s*queryFn: fetchManifest/);
});

test("EmDash's settings POST body has SEO at its top level, and staging there once EmDash has it (the middleware's purges)", async () => {
	const { settingsUpdateBody, siteSettingsSchema } = await import("emdash/api/schemas");
	const body = Object.keys(settingsUpdateBody.shape);
	assert.ok(body.includes("seo"), `settings POST body keys: ${body.join(", ")}`);
	// EmDash 1.5 adds a staging site status (src/core/site.ts reads getSiteSetting("staging")): the middleware looks for it in this body.
	if (Object.keys(siteSettingsSchema.shape ?? {}).includes("staging")) assert.ok(body.includes("staging"), "EmDash has a staging setting but saves it some other way: the middleware won't see Go live");
});

test("Settings page: the route, the form id and Kumo's Input for each secret field (src/core/settings-enhance.ts)", () => {
	assert.match(admin, /basepath: "\/_emdash\/admin"/);
	// 1.5.0 wraps the page in RequireAdmin (admins only, as the pack's settings already are).
	assert.match(admin, /path: "\/plugins-manager\/\$pluginId\/settings",\s*component: (?:PluginSettingsPage|\(\) => \/\* @__PURE__ \*\/ jsx\(RequireAdmin, \{ children: \/\* @__PURE__ \*\/ jsx\(PluginSettingsPage, \{\}\) \}\))(?![\w$])/);
	const page = functionSource(admin, "PluginSettings");
	assert.match(page, /jsxs?\("form", \{\s*id: "plugin-settings-form"/, "the settings form no longer has id plugin-settings-form");
	const field = functionSource(admin, "SettingFieldInput");
	const secret = field.slice(field.indexOf('case "secret"'));
	assert.match(secret, /^case "secret": return [\s\S]{0,200}?jsx\(Input, \{\s*type: "password",\s*label: field\.label,\s*description: field\.description,/, `the secret field isn't Kumo's Input with the schema's label and description:\n${secret.slice(0, 600)}`);
	// The older-tokens toggle relies on this: each secret is a div holding Kumo's Input, then a type="button" Clear stored
	// value button only while a value is saved (and not cleared yet). That button is how the script tells a saved secret.
	const pure = String.raw`(?:\/\*\s*@__PURE__\s*\*\/\s*)?`;
	assert.match(
		secret,
		new RegExp(String.raw`^case "secret": return ${pure}jsxs\("div", \{\s*className: "space-y-1",\s*children: \[${pure}jsx\(Input, \{`),
		`the secret field is no longer a div around Kumo's Input:\n${secret.slice(0, 600)}`,
	);
	assert.match(
		secret,
		new RegExp(String.raw`\}\), secretSet && !secretCleared && ${pure}jsx\(Button, \{\s*type: "button",[\s\S]{0,300}?message: "Clear stored value"`),
		`the Clear stored value button is no longer rendered only for a saved secret, as type="button", next to the Input:\n${secret.slice(0, 1200)}`,
	);
	// The count of older tokens follows Save by the placeholder: one for a cleared value, another for a saved one, a third for none.
	assert.match(
		secret,
		/placeholder: secretCleared \? [\s\S]{0,120}?message: "Will be cleared on save"[\s\S]{0,40}?\}\) : secretSet \? [\s\S]{0,120}?message: "Currently set[^"]*"[\s\S]{0,40}?\}\) : [\s\S]{0,80}?message: "Not set"/,
		`the secret field's placeholder no longer tells cleared, saved and empty apart:\n${secret.slice(0, 1200)}`,
	);
	// The fields are siblings in one container (the toggle is added among them).
	assert.match(page, /className: "space-y-4",\s*children: \[fields\.length === 0 && [\s\S]{0,400}?fields\.map\(\(\[key, field\]\) => [\s\S]{0,40}?jsx\(SettingFieldInput, \{/);
});

test("Settings page: the script keeps four fields in view, hides empty older tokens and the webhook secret, and tucks saved ones behind a toggle (rendered as EmDash does, with the installed Kumo)", async () => {
	const { Window } = await import("happy-dom");
	const window = new Window({ url: "https://example.com/_emdash/admin/plugins-manager/coywolf-pack/settings" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	try {
		const React = await import("react");
		const { createElement: h, act } = React;
		const { createRoot } = await import("react-dom/client");
		const { Button, Input } = await import("@cloudflare/kumo");
		const { SECRET_SETTINGS, OLDER_SECRET_KEYS } = await import("../src/core/secrets.ts");
		const { settingsEnhanceScript } = await import("../src/core/settings-enhance.ts");
		// EmDash's PluginSettings for the secrets (checked against its bundle above): its saved and cleared state, the
		// placeholder for each, and Save, which drops the cleared values and resets the cleared state.
		const page = {};
		function SecretField({ field, set, cleared, onClear }) {
			const placeholder = cleared ? "Will be cleared on save" : set ? "Currently set — enter a new value to replace" : "Not set";
			return h("div", { className: "space-y-1" }, h(Input, { type: "password", label: field.label, description: field.description, autoComplete: "new-password", placeholder, value: "", onChange() {} }), set && !cleared && h(Button, { type: "button", variant: "ghost", size: "sm", onClick: onClear }, "Clear stored value"));
		}
		function Form() {
			const [saved, setSaved] = React.useState(() => new Set(["cloudflareApiToken", "videosApiToken", "imagesApiToken", "videosWebhookSecret"]));
			const [cleared, setCleared] = React.useState(() => new Set());
			page.save = () => {
				setSaved((s) => new Set([...s].filter((k) => !cleared.has(k))));
				setCleared(new Set());
			};
			const fields = Object.entries(SECRET_SETTINGS).map(([key, field]) => h(SecretField, { key, field, set: saved.has(key), cleared: cleared.has(key), onClear: () => setCleared((c) => new Set(c).add(key)) }));
			return h("form", { id: "plugin-settings-form" }, h("div", { className: "rounded-lg" }, h("div", { className: "space-y-4" }, fields)));
		}
		const container = window.document.createElement("div");
		window.document.body.appendChild(container);
		const reactRoot = createRoot(container);
		await act(async () => reactRoot.render(h(Form)));
		const list = container.querySelector(".space-y-4");
		const reactNodes = [...list.children];
		const wrapper = (key) => [...container.querySelectorAll("label")].find((l) => l.textContent.trim() === SECRET_SETTINGS[key].label).closest(".space-y-1");

		window.eval(settingsEnhanceScript());
		await window.happyDOM.waitUntilComplete();

		for (const key of ["cloudflareApiToken", "aiApiKey", "insightsFathomApiKey", "insightsGoogleServiceAccount"]) assert.equal(wrapper(key).hidden, false, `${key} stays in view`);
		for (const key of OLDER_SECRET_KEYS) assert.equal(wrapper(key).hidden, true, `${key} is out of view`);
		assert.equal(wrapper("videosWebhookSecret").hidden, true, "the webhook secret is hidden even when saved");
		// Browsers ignore autocomplete="off" on password inputs but respect "new-password", so no field may lose EmDash's hint.
		for (const key of ["cloudflareApiToken", ...OLDER_SECRET_KEYS, "videosWebhookSecret"]) assert.equal(wrapper(key).querySelector("input").getAttribute("autocomplete"), "new-password", `${key} keeps EmDash's new-password hint`);
		const toggle = list.querySelector("[data-cw-older-toggle] button");
		assert.ok(toggle, "a toggle for the saved older tokens");
		assert.match(toggle.textContent, /Older tokens \(2\)/);
		assert.equal(toggle.getAttribute("aria-expanded"), "false");
		assert.deepEqual(toggle.getAttribute("aria-controls").split(" ").sort(), [wrapper("imagesApiToken").id, wrapper("videosApiToken").id].sort());
		assert.equal(toggle.parentElement.nextElementSibling, wrapper(OLDER_SECRET_KEYS[0]), "the toggle sits right above the older tokens");

		toggle.click();
		await window.happyDOM.waitUntilComplete();
		assert.equal(toggle.getAttribute("aria-expanded"), "true");
		assert.equal(wrapper("videosApiToken").hidden, false, "a saved older token shows once opened");
		assert.equal(wrapper("usageApiToken").hidden, true, "an empty one never shows");

		// Clear stored value (EmDash removes its button): the field stays with the older tokens, so it can still be seen.
		await act(async () => wrapper("videosApiToken").querySelector("button[type=button]").click());
		await window.happyDOM.waitUntilComplete();
		assert.equal(wrapper("videosApiToken").querySelector("button"), null);
		assert.equal(wrapper("videosApiToken").hidden, false);
		assert.match(toggle.textContent, /Older tokens \(2\)/, "not saved yet: still counted");

		// Save Settings: the cleared token is gone, so it leaves the list and the count goes down, without a reload.
		await act(async () => page.save());
		await window.happyDOM.waitUntilComplete();
		assert.equal(wrapper("videosApiToken").hidden, true);
		assert.match(toggle.textContent, /Older tokens \(1\)/);
		assert.equal(toggle.getAttribute("aria-controls"), wrapper("imagesApiToken").id);

		// React's own nodes were never moved: the same elements, in the same order, beside the one added toggle.
		assert.deepEqual([...list.children].filter((n) => !n.hasAttribute("data-cw-older-toggle")), reactNodes);

		// Leaving the page (the admin is a single-page app): the toggle doesn't linger.
		window.history.pushState({}, "", "/_emdash/admin/plugins");
		list.appendChild(window.document.createElement("span"));
		await window.happyDOM.waitUntilComplete();
		assert.equal(list.querySelector("[data-cw-older-toggle]").hidden, true);
		await act(async () => reactRoot.unmount());
	} finally {
		await window.happyDOM.close();
	}
});

test("Settings page guides: the pack's script finds Kumo's secret fields by label and adds the guides (rendered with the installed Kumo)", async () => {
	const { Window } = await import("happy-dom");
	const window = new Window({ url: "https://example.com/_emdash/admin/plugins-manager/coywolf-pack/settings" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	try {
		const { createElement: h, act } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { Input } = await import("@cloudflare/kumo");
		const { SECRET_SETTINGS } = await import("../src/core/secrets.ts");
		const { SETTINGS_PAGE_GUIDES } = await import("../src/core/guide-content.ts");
		const { settingsEnhanceScript } = await import("../src/core/settings-enhance.ts");
		const container = window.document.createElement("div");
		window.document.body.appendChild(container);
		const reactRoot = createRoot(container);
		// As EmDash's SettingFieldInput renders a secret (checked against its bundle above).
		const fields = Object.entries(SECRET_SETTINGS).map(([key, field]) =>
			h(Input, { key, type: "password", label: field.label, description: field.description, autoComplete: "new-password", placeholder: "Not set", value: "", onChange() {} }),
		);
		await act(async () => reactRoot.render(h("form", { id: "plugin-settings-form" }, h("div", null, fields))));
		const inputs = [...container.querySelectorAll("input")];
		for (const input of inputs) {
			assert.ok(input.getAttribute("aria-labelledby") && input.getAttribute("aria-describedby"), `Kumo's Input no longer labels and describes its input by id:\n${input.outerHTML}`);
		}
		window.eval(settingsEnhanceScript());
		await window.happyDOM.waitUntilComplete();
		const guided = Object.keys(SETTINGS_PAGE_GUIDES).filter((key) => key in SECRET_SETTINGS);
		assert.ok(guided.length > 0);
		assert.equal(container.querySelectorAll("[data-cw-guides]").length, guided.length, `guides added:\n${container.innerHTML.slice(0, 2000)}`);
		for (const input of inputs.filter((i) => i.getAttribute("data-cw-guide"))) {
			assert.ok(window.document.getElementById(input.getAttribute("aria-describedby"))?.hasAttribute("data-cw-intro"), "the input is described by the guide's intro");
		}
		// The token guide's child lists arrive as lists: each permission its own item, under a numbered step and in the note.
		const { CLOUDFLARE_PERMISSIONS } = await import("../src/core/guide-content.ts");
		const tokenGuide = [...container.querySelectorAll("[data-cw-guides]")].find((g) => g.textContent.includes("Which feature needs which"));
		assert.ok(tokenGuide, "the Cloudflare API token's guide is on the page");
		const stepItems = [...tokenGuide.querySelectorAll("ol > li > ul > li")].map((li) => li.textContent);
		const noteItems = [...tokenGuide.querySelectorAll("details > div > div > ul > li")].map((li) => li.textContent);
		for (const p of Object.values(CLOUDFLARE_PERMISSIONS)) {
			assert.equal(stepItems.filter((t) => t.startsWith(p.name)).length, 1, `${p.name}: one item in the steps`);
			assert.equal(noteItems.filter((t) => t.startsWith(`${p.name}: `)).length, 1, `${p.name}: one item in the note`);
		}
		for (const ul of tokenGuide.querySelectorAll("ul")) assert.match(ul.getAttribute("style") ?? "", /list-style:\s*disc/);
		await act(async () => reactRoot.unmount());
	} finally {
		await window.happyDOM.close();
	}
});

test("Astro's cookies (on the response under Symbol.for(\"astro.cookies\")) survive the pack's admin page rewrite", async () => {
	// src/core/settings-enhance.ts copies the symbol onto the rebuilt response, as EmDash's middleware does.
	const astroDir = packageDir("astro");
	const { attachCookiesToResponse, getCookiesFromResponse } = await import(pathToFileURL(join(astroDir, "dist/core/cookies/response.js")).href);
	const { injectAdminEnhancements } = await import("../src/core/settings-enhance.ts");
	const cookies = { consume: () => [] };
	const response = new Response("<html><body></body></html>", { headers: { "content-type": "text/html" } });
	attachCookiesToResponse(response, cookies);
	const out = await injectAdminEnhancements(response);
	assert.notEqual(out, response);
	assert.equal(getCookiesFromResponse(out), cookies);
	assert.match(await out.text(), /<script data-coywolf-pack>/);
});

// ── Admin pages: router, toasts, plugin page rendering ─────────

test("the admin is a TanStack Router app at /_emdash/admin, and the router puts itself on window.__TSR_ROUTER__ (src/admin/router.ts: the unsaved-changes guard and in-admin links)", () => {
	assert.ok(adminPkg.dependencies?.["@tanstack/react-router"], `@emdash-cms/admin ${adminPkg.version} no longer depends on @tanstack/react-router`);
	assert.match(admin, /createRouter\(\{[\s\S]{0,200}?basepath: "\/_emdash\/admin"/);
	// EmDash's own guard blocks through the same history (useBlocker → router.history.block), which the pack's guard uses too.
	assert.match(functionSource(admin, "UnsavedChangesGuard"), /useBlocker\(\{/);
	const routerCore = packageDir("@tanstack/router-core", packageDir("@tanstack/react-router", adminDir));
	const router = readFileSync(join(routerCore, "dist/esm/router.js"), "utf8");
	assert.match(router, /self\.__TSR_ROUTER__ = this/, "TanStack's Router no longer sets window.__TSR_ROUTER__: the pack's guard falls back to the browser's prompt only");
	const history = readFileSync(join(packageDir("@tanstack/history", routerCore), "dist/esm/index.js"), "utf8");
	assert.match(history, /block: \(blocker\) =>/);
	assert.match(history, /const isBlocked = await blocker\.blockerFn\(\{/);
});

test("plugin pages render inside the admin's <Toasty> and RouterProvider, bare (src/admin/page.tsx adds the boundary and Suspense)", () => {
	assert.match(admin, /jsx\(Toasty, \{ children:[\s\S]{0,1200}?jsx\(RouterProvider, \{ router \}\)/);
	assert.match(functionSource(admin, "PluginPage"), /if \(PluginComponent\) return \/\* @__PURE__ \*\/ jsx\(PluginComponent, \{\}\)/);
});

test("refreshing the manifest keeps a plugin page mounted and scrolled (src/admin/extensions.ts refreshAdminManifest, the Features page's Save)", () => {
	// The admin layout swaps the page for its loading screen only before the first manifest (isLoading), not on a refetch.
	const layout = functionSource(admin, "RootComponent");
	assert.match(layout, /const \{ data: manifest, isLoading, error \} = useQuery\(\{\s*queryKey: \["manifest"\],/);
	// 1.5.0 also waits for the current user, on first load only (userSettled never goes back to false).
	assert.match(layout, /if \(isLoading(?: \|\| !userSettled)?\) return \/\* @__PURE__ \*\/ jsx\(ConfigurationLoadingScreen, \{\}\);/);
	if (layout.includes("userSettled")) {
		assert.match(layout, /if \(!userSettled && !currentUser\.isLoading\) setUserSettled\(true\);/);
		assert.doesNotMatch(layout, /setUserSettled\(false\)/, "the layout can go back to its loading screen after the first load: a refetch may remount the page");
	}
	// A refetch that fails (after the admin's one retry) swaps the page for the error screen: the only case a refresh unmounts it.
	assert.match(layout, /if \(error \|\| !manifest\) return \/\* @__PURE__ \*\/ jsx\(ErrorScreen, \{ error:/);
	assert.match(admin, /new QueryClient\(\{ defaultOptions: \{ queries: \{\s*staleTime: [^,]+,\s*retry: 1\s*\} \} \}\)/);
	// Nothing else in the layout returns early or keys the shell: those would remount the page on a refetch.
	assert.equal(layout.match(/\breturn\b/g)?.length, 3, `the layout has another early return:\n${layout}`);
	assert.doesNotMatch(layout, /isFetching|isRefetching|key: /, "the layout now reacts to a refetch: the page may remount");
	assert.match(layout, /jsx\(Shell, \{\s*manifest,\s*children: \/\* @__PURE__ \*\/ jsx\(Outlet, \{\}\)/);
	// The page scrolls inside the shell's <main>, which stays across manifest changes; plugin pages come from a fixed registry, not the manifest.
	assert.match(functionSource(admin, "Shell"), /jsx\("main", \{\s*className: fullBleed \? [^:]+: "flex-1 overflow-y-auto[^"]*",\s*children\s*\}\)/);
	assert.match(functionSource(admin, "usePluginPage"), /useContext\(PluginAdminContext\)/);
	// The admin brings its own React Query (a dependency, not a peer), so a site can have two copies, each with its own
	// context, and the pack's useQueryClient() then can't see the admin's client: the router's context is the way to it.
	assert.ok(adminPkg.dependencies?.["@tanstack/react-query"], "@emdash-cms/admin no longer brings its own React Query");
	assert.match(functionSource(admin, "createAdminRouter"), /context: \{ queryClient \}/);
	assert.match(admin, /const queryClient = new QueryClient\(/);
});

test("entry editor panels and content-list columns: read from the plugin's admin module, picked by a synchronous collections predicate re-run when manifest.plugins changes, and the manifest is in the router context's queryClient (src/admin/extensions.ts)", async () => {
	// The admin registry imports each plugin's admin entry as a namespace, so named exports reach pluginAdmins.
	const registry = [...emdashDist.values()].find((src) => src.includes("function generateAdminRegistryModule("));
	assert.ok(registry, "no generateAdminRegistryModule");
	assert.match(functionSource(registry, "generateAdminRegistryModule"), /import \* as \$\{varName\} from "\$\{descriptor\.adminEntry\}";/);
	// Panels: pluginAdmins[id].contentEditorPanels, predicate called with the collection, disabled plugins skipped, role checked.
	const panels = functionSource(admin, "resolveContentEditorPanels");
	assert.match(panels, /pluginAdmins\[pluginId\]\?\.contentEditorPanels/);
	assert.match(admin, /function appliesToCollection\$1\(pluginId, panel, collection\) \{[\s\S]{0,300}?return panel\.collections\(collection\);/);
	assert.match(panels, /candidate\.minRole !== void 0 && userRole < candidate\.minRole/);
	// 1.4.0 calls it from the editor; 1.5.0 through resolveEditorExtensionSections (the editor sidebar's sections), which
	// passes the manifest's plugins on. Either way the memo re-runs when manifest.plugins changes.
	if (admin.includes("function resolveEditorExtensionSections(")) {
		assert.match(functionSource(admin, "resolveEditorExtensionSections"), /resolveContentEditorPanels\(pluginAdmins, collection, role, plugins\)/);
		assert.match(admin, /resolveEditorExtensionSections\(pluginAdmins, manifest\?\.plugins, collection, currentUser\?\.role \?\? 0\) : \[\], \[[\s\S]{0,120}?manifest\?\.plugins,/);
	} else assert.match(admin, /resolveContentEditorPanels\(pluginAdmins, collection, currentUser\?\.role \?\? 0, manifest\?\.plugins\) : \[\], \[[\s\S]{0,120}?manifest\?\.plugins,/);
	assert.match(admin, /jsx\(Panel, \{\s*collection,\s*entry: item,\s*locale:/);
	// Columns: the same, keyed on pluginStates = manifest.plugins; cells get the page's visibleItems.
	const columns = functionSource(admin, "resolveContentListColumns");
	assert.match(columns, /pluginAdmins\[pluginId\]\?\.contentListColumns/);
	assert.match(admin, /function appliesToCollection\(pluginId, column, collection\) \{[\s\S]{0,300}?return column\.collections\(collection\);/);
	assert.match(admin, /resolveContentListColumns\(pluginAdmins, collection, userRole, pluginStates\), \[[\s\S]{0,80}?pluginStates,/);
	assert.match(admin, /pluginStates: manifest\.plugins,/);
	assert.match(admin, /jsx\(Cell, \{\s*collection,\s*item,\s*locale: item\.locale,\s*visibleItems\s*\}\)/);
	// The router's context carries the React Query client that holds ["manifest"].
	assert.match(functionSource(admin, "createAdminRouter"), /context: \{ queryClient \}/);
	assert.match(admin, /queryKey: \["manifest"\]/);
	// The manifest's plugin entry lists the admin pages EmDash got from plugin.admin.pages (the pack's live getter).
	const runtime = [...emdashDist.values()].find((src) => src.includes("_buildManifest()"));
	assert.match(runtime, /enabled,\s*adminMode,\s*adminPages: plugin\.admin\?\.pages \?\? \[\]/);
	// And the predicate the pack hands EmDash reads it from there.
	const { packPageOn } = await import("../src/admin/extensions.ts");
	const queryClient = { getQueryData: (key) => (key[0] === "manifest" ? { plugins: { "coywolf-pack": { enabled: true, adminPages: [{ path: "/links" }] } } } : undefined) };
	const router = { navigate() {}, history: { block: () => () => {} }, options: { basepath: "/_emdash/admin", context: { queryClient } } };
	assert.equal(packPageOn("/links", { __TSR_ROUTER__: router }), true);
	assert.equal(packPageOn("/schema", { __TSR_ROUTER__: router }), false);
});

test("EmDash's generated plugins module: an array made at import (1.4) or a cached plugins() function (1.5+), as src/core/ready.ts handles", () => {
	const virtualModules = [...emdashDist.values()].find((src) => src.includes("function generatePluginsModule("));
	assert.ok(virtualModules, "no generatePluginsModule");
	const generator = functionSource(virtualModules, "generatePluginsModule");
	const lazy = /export function plugins\(\) \{[\s\S]{0,200}?Symbol\.for\("emdash:plugins"\)[\s\S]{0,200}?\?\?= \[/.test(generator);
	const eager = /export const plugins = \[/.test(generator);
	assert.ok(lazy !== eager, `the plugins module has another shape: ensurePackStarted() can't start the pack:\n${generator.slice(-900)}`);
	// Native plugins still come from the entrypoint's createPlugin(options), which marks the pack ready.
	assert.match(generator, /import \{ createPlugin as \$\{varName\} \} from "\$\{descriptor\.entrypoint\}";/);
	if (lazy) {
		// EmDash's middleware reads it the same way.
		const middleware = readFileSync(join(emdashDir, "src/astro/middleware.ts"), "utf8");
		assert.match(middleware, /typeof plugins === "function" \? plugins\(\) : plugins/);
	}
});

test("EmDash runs plugin:install, then plugin:activate, once for a config plugin with no _plugin_state row (the 0.36.0 defaults: src/core/features.ts recordDefaults)", () => {
	const runtime = [...emdashDist.values()].find((src) => src.includes("installUnrecordedConfigPlugins(configPlugins"));
	assert.ok(runtime, `EmDash ${emdashVersion} no longer installs unrecorded config plugins at boot`);
	const install = runtime.slice(runtime.indexOf("installUnrecordedConfigPlugins(configPlugins"));
	// In this order, within the one loop (1.5.0 put sandbox-readiness checks between them; the order is the same).
	const body = install.slice(0, install.indexOf("if (failed.length === 0)") === -1 ? 4000 : install.indexOf("if (failed.length === 0)"));
	const steps = ["if (recordedStates.has(plugin.id)) continue;", "createActiveIfAbsent(plugin.id", "runPluginInstall(plugin.id)", "runPluginActivate(plugin.id)"].map((step) => [step, body.indexOf(step)]);
	for (const [step, at] of steps) assert.notEqual(at, -1, `installUnrecordedConfigPlugins no longer has ${step}`);
	assert.deepEqual(steps.map(([, at]) => at), steps.map(([, at]) => at).toSorted((a, b) => a - b), "install and activate no longer run in this order");
	assert.match(runtime, /runtime\.installUnrecordedConfigPlugins\(/, "the boot no longer calls it");
});

// Run: node --test test/pagination-render.test.mjs
//
// The Pagination component (src/astro/pagination/Pagination.astro), rendered by Astro itself: the .astro
// files are compiled with Astro's own compiler and rendered through its container API
// (experimental_AstroContainer), on a page with two navs (test/fixtures/pagination-page.astro). What the
// markup and CSS are is checked in test/pagination.test.mjs; this checks what only a render shows: the CSS
// once per page, a heading id per nav, the props' defaults, the switches, the `database` prop and escaping.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Astro's compiler, the copy Astro itself depends on.
const astroRequire = createRequire(createRequire(import.meta.url).resolve("astro/package.json"));
const { transform } = await import(pathToFileURL(astroRequire.resolve("@astrojs/compiler-rs")).href);

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { globalThis.__waitUntil?.push(p); };`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
	// What Astro's Vite plugin does for a site: compile the component to a module (the compiler strips its TypeScript too).
	load(url, context, next) {
		if (!url.endsWith(".astro")) return next(url, context);
		const filename = fileURLToPath(url);
		const result = transform(readFileSync(filename, "utf8"), { filename, internalURL: "astro/compiler-runtime", resolvePath: (specifier) => specifier });
		const failed = result.diagnostics.find((d) => d.severity === "error");
		if (failed) throw new Error(`${filename}: ${failed.text}`);
		return { format: "module", source: result.code, shortCircuit: true };
	},
});

const { experimental_AstroContainer } = await import("astro/container");
const { default: Page } = await import("./fixtures/pagination-page.astro");
const { default: Pagination } = await import("../src/astro/pagination/Pagination.astro");
const { PAGINATION_CSS } = await import("../src/pagination/css.ts");
const features = await import("../src/core/features.ts");
const { Window } = await import("happy-dom");

/** A D1 stand-in over node:sqlite with the options table, the feature switches stored. */
function d1(switches = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT DEFAULT '0' NOT NULL);");
	db.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify(switches));
	const exec = (sql, params) => ({ results: db.prepare(sql).all(...params) });
	const statement = (sql, params = []) => ({ sql, params, bind: (...p) => statement(sql, p), all: async () => exec(sql, params), first: async () => exec(sql, params).results[0] ?? null });
	return { prepare: (sql) => statement(sql), batch: async (statements) => statements.map((s) => exec(s.sql, s.params)) };
}

/** A fresh isolate whose site database (the "DB" binding) has these switches. */
function site(switches) {
	globalThis.__testEnv = { DB: d1(switches) };
	globalThis.__waitUntil = [];
	features.invalidateFeatures();
}

const container = await experimental_AstroContainer.create();
/** Render a component as part of one page (its own Astro.locals), and parse the result. */
async function render(component, props) {
	const html = await container.renderToString(component, { props, locals: {} });
	const window = new Window();
	window.document.write(`<!doctype html><html><body>${html}</body></html>`);
	return { html, document: window.document, close: () => window.happyDOM.close() };
}
const texts = (nodes) => [...nodes].map((n) => n.textContent);
const hrefs = (document, selector) => [...document.querySelectorAll(selector)].map((a) => a.getAttribute("href"));

test("two navs on one page: the CSS once, before the first nav, and a heading id of its own for each", async () => {
	site({ pagination: true });
	const news = { base: "/news/", page: 3, perPage: 10, count: 200, hasMore: true };
	const page = await render(Page, { top: news, bottom: { ...news, label: "More pages" } });
	try {
		const styles = page.document.querySelectorAll("style");
		assert.equal(styles.length, 1, "one stylesheet for both navs");
		assert.equal(styles[0].textContent, PAGINATION_CSS);
		const navs = [...page.document.querySelectorAll("nav.cw-pagination")];
		assert.equal(navs.length, 2);
		assert.ok(styles[0].compareDocumentPosition(navs[0]) & 4, "the stylesheet comes before the first nav");
		assert.deepEqual(navs.map((nav) => nav.getAttribute("aria-labelledby")), ["cw-pagination-1", "cw-pagination-2"]);
		// Each nav is named by its own heading, and no id repeats in the page.
		assert.deepEqual(navs.map((nav) => page.document.getElementById(nav.getAttribute("aria-labelledby")).textContent), ["Pagination", "More pages"]);
		const ids = [...page.document.querySelectorAll("[id]")].map((el) => el.id);
		assert.equal(new Set(ids).size, ids.length, ids.join(" "));
		assert.equal(page.document.querySelectorAll('a[aria-current="page"]').length, 2, "one current page per nav");
	} finally {
		await page.close();
	}
});

test("a nav with nothing to show prints nothing and takes no id or stylesheet; styles={false} prints no CSS", async () => {
	site({ pagination: true });
	// The top nav has one page: the bottom one is the page's first nav.
	const page = await render(Page, { top: { base: "/", page: 1, perPage: 10, count: 4, hasMore: false }, bottom: { base: "/news/", page: 1, perPage: 10, count: 40, hasMore: true } });
	try {
		assert.equal(page.document.querySelectorAll("nav").length, 1);
		assert.equal(page.document.querySelector("nav").getAttribute("aria-labelledby"), "cw-pagination-1");
		assert.equal(page.document.querySelectorAll("style").length, 1);
		assert.ok(page.document.querySelector("main > p").compareDocumentPosition(page.document.querySelector("style")) & 4, "the stylesheet goes with the nav that renders");
	} finally {
		await page.close();
	}
	const none = await render(Pagination, { base: "/", page: 1, perPage: 10, count: 4, hasMore: false });
	assert.equal(none.html.trim(), "");
	await none.close();
	const bare = await render(Page, { top: { base: "/", page: 2, perPage: 10, count: 40, styles: false }, bottom: { base: "/", page: 2, perPage: 10, count: 40, styles: false } });
	try {
		assert.equal(bare.document.querySelectorAll("style").length, 0);
		assert.equal(bare.document.querySelectorAll("nav").length, 2);
	} finally {
		await bare.close();
	}
});

test("the props' defaults: a level 2 heading named Pagination, no query; without a count, no last page and Next from hasMore", async () => {
	site({ pagination: true });
	const counted = await render(Pagination, { base: "/news/", page: 2, perPage: 10, count: 95 });
	try {
		const heading = counted.document.querySelector("nav > h2.cw-visually-hidden");
		assert.equal(heading.textContent, "Pagination");
		assert.equal(heading.id, "cw-pagination-1");
		assert.deepEqual(texts(counted.document.querySelectorAll("li[data-l] a")), ["Page 1", "Page 2", "Page 3", "Page 4", "Page 10"]);
		assert.deepEqual(hrefs(counted.document, "li[data-l] a"), ["/news/", "/news/page/2/", "/news/page/3/", "/news/page/4/", "/news/page/10/"], "/page/N/ while Short page URLs is off");
		assert.equal(counted.document.querySelector('a[rel="prev"]').textContent, "Previous page");
		assert.equal(counted.document.querySelector('a[rel="next"]').textContent, "Next page");
	} finally {
		await counted.close();
	}
	// A page as a string (Astro.params) and a count of null: the same as leaving the count out.
	const unknown = await render(Pagination, { base: "/", page: "4", perPage: 10, count: null, hasMore: true });
	try {
		assert.deepEqual(texts(unknown.document.querySelectorAll("li[data-l] a")), ["Page 1", "Page 2", "Page 3", "Page 4", "Page 5"]);
		assert.equal(unknown.document.querySelector('a[rel="next"]').getAttribute("href"), "/page/5/");
	} finally {
		await unknown.close();
	}
	const ended = await render(Pagination, { base: "/", page: 4, perPage: 10, hasMore: false });
	assert.equal(ended.document.querySelector('a[rel="next"]'), null);
	assert.ok(ended.document.querySelector('a[rel="prev"]'));
	await ended.close();
	const leveled = await render(Pagination, { base: "/", page: 2, perPage: 10, count: 40, headingLevel: 3, label: "Older posts" });
	assert.equal(leveled.document.querySelector("nav > h3").textContent, "Older posts");
	await leveled.close();
});

test("the two switches are independent: numbers from Pagination, /N/ links from Short page URLs, in any combination", async () => {
	const props = { base: "/news/", page: 2, perPage: 10, count: 95 };
	for (const [switches, numbered, next] of [
		[{}, false, "/news/page/3/"],
		[{ pagination: true }, true, "/news/page/3/"],
		[{ shortPageUrls: true }, false, "/news/3/"],
		[{ pagination: false, shortPageUrls: true }, false, "/news/3/"],
		[{ pagination: true, shortPageUrls: true }, true, "/news/3/"],
	]) {
		site(switches);
		const page = await render(Pagination, props);
		try {
			assert.equal(page.document.querySelectorAll("li[data-l]").length > 0, numbered, JSON.stringify(switches));
			assert.equal(page.document.querySelector('a[rel="next"]').getAttribute("href"), next, JSON.stringify(switches));
			assert.equal(page.document.querySelector('a[rel="prev"]').getAttribute("href"), "/news/", "page 1 is the base");
		} finally {
			await page.close();
		}
	}
});

test("the database prop: the switches come from the binding it's given, not from DB", async () => {
	site({});
	const other = d1({ pagination: true, shortPageUrls: true });
	const page = await render(Pagination, { base: "/", page: 2, perPage: 10, count: 95, database: other });
	try {
		assert.deepEqual(hrefs(page.document, "li[data-l] a").slice(0, 3), ["/", "/2/", "/3/"]);
	} finally {
		await page.close();
	}
	// By name too.
	globalThis.__testEnv = { DB: d1({}), SITE_DB: other };
	features.invalidateFeatures();
	const named = await render(Pagination, { base: "/", page: 2, perPage: 10, count: 95, database: "SITE_DB" });
	assert.equal(named.document.querySelector('a[rel="next"]').getAttribute("href"), "/3/");
	await named.close();
});

test("escaping: the label, the base and the query can't add markup", async () => {
	site({ pagination: true, shortPageUrls: true });
	const page = await render(Pagination, { base: '/tag/a"b<c>/', page: 2, perPage: 10, count: 30, label: 'Older & <b>newer</b> "posts"', query: { s: '"><script>alert(1)</script>' } });
	try {
		assert.ok(!/<script|<b>|<c>/.test(page.html.replace(/<style[\s\S]*?<\/style>/, "")), "no element from a prop");
		assert.equal(page.document.querySelector("nav > h2").textContent, 'Older & <b>newer</b> "posts"');
		assert.equal(page.document.querySelector("nav > h2").children.length, 0);
		assert.equal(page.document.querySelector('a[rel="next"]').getAttribute("href"), '/tag/a"b<c>/3/?s=%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E');
		assert.equal(page.document.querySelectorAll("script").length, 0);
		assert.equal(page.document.querySelectorAll("nav a").length, 5, "Previous, 1, 2, 3, Next");
	} finally {
		await page.close();
	}
});

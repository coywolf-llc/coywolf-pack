// Run: node --test test/token-guides.test.mjs
//
// The Cloudflare token guides (src/core/guide-content.ts): one pre-filled form for the one Cloudflare API token,
// written for Cloudflare's token editor (permission policies with a scope), using only keys from Cloudflare's
// permission reference and saying exactly what the form should show; module guides say what the token needs there.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { GUIDES, CLOUDFLARE_PERMISSIONS, CLOUDFLARE_TOKEN_FORM, tokenFormUrl, guideHtml } = await import("../src/core/guide-content.ts");

// developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/ (permission reference).
const DOCUMENTED = new Set(["account_analytics", "account_api_tokens", "account_settings", "billing", "workers_scripts", "workers_kv_storage", "workers_routes", "workers_r2", "d1", "queues", "page", "stream", "images", "account_logs", "dns", "zone", "zone_settings", "analytics", "firewall_services", "page_rules", "cache", "ssl_and_certificates", "logs"]);
const ZONE_KEYS = new Set(["dns", "zone", "zone_settings", "analytics", "firewall_services", "page_rules", "cache", "ssl_and_certificates", "logs"]);
const FEATURE_GUIDES = ["stream", "radar", "images-token", "crawler-hints-token", "checkup-read-token", "checkup-setup-token", "insights-token", "backups-token", "browser-run-token", "files-token", "usage-token"];

const formLinks = (html) => [...html.matchAll(/href="(https:\/\/dash\.cloudflare\.com\/\?to=\/:account\/api-tokens(?:&amp;|&)permissionGroupKeys=[^"]+)"/g)].map((m) => new URL(m[1].replaceAll("&amp;", "&")));
const text = (html) => html.replace(/<[^>]+>/g, "");

test("the pre-filled form URL is Cloudflare's account token template", () => {
	const url = new URL(tokenFormUrl("Coywolf Pack read-only", [{ key: "zone", type: "read" }]));
	assert.equal(url.origin + url.pathname, "https://dash.cloudflare.com/");
	assert.equal(url.searchParams.get("to"), "/:account/api-tokens");
	assert.deepEqual(JSON.parse(url.searchParams.get("permissionGroupKeys")), [{ key: "zone", type: "read" }]);
	assert.equal(url.searchParams.get("name"), "Coywolf Pack read-only");
	// The link Crawler Hints shipped with in 0.35.18, unchanged.
	assert.equal(url.href.replace("https://dash.cloudflare.com/?", ""), "to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D&name=Coywolf%20Pack%20read-only");
});

test("one pre-filled form in all the guides: documented keys only, never D1, each key in the policy its scope belongs to", () => {
	const forms = Object.entries(GUIDES).flatMap(([id, g]) => formLinks(g.steps.join(" ")).map((url) => ({ id, url })));
	assert.deepEqual(forms.map((f) => f.id), ["cloudflare-token"], "only the Cloudflare API token guide has a form; the module guides point to it");
	const keys = JSON.parse(forms[0].url.searchParams.get("permissionGroupKeys"));
	assert.equal(forms[0].url.searchParams.get("name"), CLOUDFLARE_TOKEN_FORM.name);
	assert.ok(keys.length > 0);
	for (const { key, type } of keys) {
		assert.ok(DOCUMENTED.has(key), `${key} isn't in Cloudflare's permission reference`);
		assert.ok(["read", "edit"].includes(type), `${key}: ${type}`);
	}
	// Restores keep their own D1 Edit token: the token saved in the database must not be able to rewrite it.
	assert.ok(!keys.some((k) => k.key === "d1"));
	assert.ok(!Object.values(CLOUDFLARE_PERMISSIONS).some((p) => /\bD1\b/.test(p.name)));
	for (const p of Object.values(CLOUDFLARE_PERMISSIONS)) if (p.form) assert.equal(ZONE_KEYS.has(p.form.key), p.scope === "zone", `${p.name} is listed in the ${p.scope} policy`);
});

test("the guide says exactly what the form shows, and lists everything else to add by hand", () => {
	const guide = GUIDES["cloudflare-token"].steps.join(" ");
	const plain = text(guide);
	const shows = guide.slice(guide.indexOf("The form should show"), guide.indexOf("Add the rest by hand"));
	const byHand = guide.slice(guide.indexOf("Add the rest by hand"), guide.indexOf("You can skip"));
	assert.match(text(shows), new RegExp(`the name ${CLOUDFLARE_TOKEN_FORM.name} and two policies`));
	const named = (html, name) => html.includes(`>${name}</strong>`);
	for (const p of Object.values(CLOUDFLARE_PERMISSIONS)) {
		// A pre-filled permission is named among what the form shows, and nowhere in the by-hand list; the others the reverse.
		assert.equal(named(shows, p.name), Boolean(p.form), `${p.name}: shows`);
		assert.equal(named(byHand, p.name), !p.form, `${p.name}: added by hand`);
	}
	assert.match(guide, /Permission policies/);
	assert.match(plain, /Specified Domains and pick this site's domain \(recommended/);
	assert.match(plain, /choose All Domains instead/);
	assert.match(plain, /CLOUDFLARE_API_TOKEN/);
});

/** The items of each <ul> in `html`, in order (a child list's items: no nesting deeper than one level here). */
const childLists = (html) => [...html.matchAll(/<ul\b[^>]*>(.*?)<\/ul>/g)].map((m) => [...m[1].matchAll(/<li>(.*?)<\/li>/g)].map((li) => li[1]));
const strongName = (item) => item.match(/^<strong class="font-medium">([^<]+)<\/strong>/)?.[1];

test("the token guide lists each permission as its own item: a child list per policy, both for the form and by hand, and in the note", () => {
	const steps = GUIDES["cloudflare-token"].steps;
	const form = steps.find((s) => s.includes("The form should show"));
	const byHand = steps.find((s) => s.includes("Add the rest by hand"));
	const names = (list) => list.map((p) => p.name);
	const all = Object.values(CLOUDFLARE_PERMISSIONS);
	const of = (scope, prefilled) => all.filter((p) => p.scope === scope && Boolean(p.form) === prefilled);
	// Never one inline run: each policy is a child list, one permission per <li>, in the editor's order.
	assert.deepEqual(childLists(form).map((items) => items.map(strongName)), [names(of("account", true)), names(of("zone", true))]);
	assert.deepEqual(childLists(byHand).map((items) => items.map(strongName)), [names(of("account", false)), names(of("zone", false))]);
	for (const p of all) if (p.find) assert.ok(byHand.includes(`<li><strong class="font-medium">${p.name}</strong> (${p.find})</li>`), `${p.name}: its own item, with its search hint`);
	assert.doesNotMatch(text(form + byHand), /→ (Read|Edit|Purge|Read-Only), [A-Z]/, "no comma-separated run of permissions");
	// "Which feature needs which": one permission per item, with what it's for.
	const note = childLists(GUIDES["cloudflare-token"].note);
	assert.equal(note.length, 1);
	assert.deepEqual(note[0].map(strongName), names(all));
	for (const [i, p] of all.entries()) assert.equal(text(note[0][i]), `${p.name}: ${p.for}`);
});

test("guides use a list for three or more permissions, inline for one or two; the rendered lists keep their bullets", () => {
	for (const id of FEATURE_GUIDES) {
		const step = GUIDES[id].steps.find((s) => s.includes("Here it needs"));
		const lists = childLists(step);
		const count = lists.length ? lists[0].length : [...step.slice(step.indexOf("Here it needs")).matchAll(/<strong class="font-medium">/g)].length;
		assert.equal(lists.length > 0, count >= 3, `${id}: ${count} permissions ${lists.length ? "as a list" : "inline"}`);
	}
	// Tailwind's preflight removes list styles in EmDash's admin: the child lists carry their own, like the steps' <ol>.
	const html = guideHtml(GUIDES["cloudflare-token"]);
	const uls = html.match(/<ul\b[^>]*>/g) ?? [];
	assert.ok(uls.length >= 5, "the form's two policies, the two by hand, and the note");
	for (const ul of uls) assert.match(ul, /style="list-style:disc;padding-inline-start:1\.25rem"/);
	assert.match(html, /<ol class="space-y-1\.5" style="list-style:decimal;padding-inline-start:1\.25rem">/);
	// A note with a list is a <div>: a <ul> can't sit inside a <p>.
	assert.doesNotMatch(html, /<p[^>]*>(?:(?!<\/p>).)*<ul/);
});

test("the zone rule and cache permissions carry the names Cloudflare's token editor shows", () => {
	const P = CLOUDFLARE_PERMISSIONS;
	assert.deepEqual([P.transformRules.name, P.cacheRules.name, P.cachePurge.name], ["Zone Transform Rules → Edit", "Cache Settings → Edit", "Cache → Purge"]);
	assert.equal(P.botManagement.name, "Bot Management → Read");
	for (const id of ["transformRules", "cacheRules", "cachePurge"]) assert.deepEqual([P[id].scope, P[id].form], ["zone", undefined], `${id}: a zone permission added by hand`);
});

test("each search hint finds its row, and tells apart the rows one search lists together", () => {
	const all = Object.values(CLOUDFLARE_PERMISSIONS);
	const row = (p) => p.name.split(" → ")[0];
	const level = (p) => p.name.split(" → ")[1];
	const term = (p) => text(p.find).match(/search for “([^”]+)”/)?.[1];
	const hinted = all.filter((p) => p.find);
	assert.deepEqual(hinted.map((p) => p.name), ["Zone Transform Rules → Edit", "Cache Settings → Edit", "Cache → Purge"]);
	for (const p of hinted) {
		const word = term(p);
		assert.ok(word, `${p.name}: the hint says what to search for`);
		assert.ok(row(p).toLowerCase().includes(word.toLowerCase()), `searching "${word}" doesn't find ${row(p)}`);
		// A search word that lists another of the token's rows too: the hint names the exact row, its description and its level.
		const alsoListed = all.filter((o) => o.scope === p.scope && row(o) !== row(p) && row(o).toLowerCase().includes(word.toLowerCase()));
		if (!alsoListed.length) continue;
		assert.ok(p.find.includes(`>${row(p)}</strong>`), `${p.name}: the hint names the exact row`);
		assert.match(text(p.find), new RegExp(`set it to ${level(p)}$`), `${p.name}: the hint names the level`);
		assert.match(text(p.find), /“Grants [^”]+”/, `${p.name}: the hint quotes the row's description`);
	}
	assert.equal(term(CLOUDFLARE_PERMISSIONS.transformRules), "transform");
	assert.match(text(CLOUDFLARE_PERMISSIONS.cacheRules.find), /named Cache Settings \(“Grants write access to cache settings phase”\), not the one named just Cache/);
	assert.match(text(CLOUDFLARE_PERMISSIONS.cachePurge.find), /named just Cache \(“Grants access to purge cache”\), not Cache Settings/);

	// The hints reach the reader: in the token's own guide, and in each module guide that needs the permission.
	const tokenGuide = GUIDES["cloudflare-token"].steps.join(" ");
	for (const p of all) if (p.find) assert.ok(tokenGuide.includes(`>${p.name}</strong> (${p.find})`), `${p.name}: hint in the Cloudflare API token guide`);
	const images = GUIDES["images-token"];
	assert.ok(images.steps.join(" ").includes(CLOUDFLARE_PERMISSIONS.transformRules.find));
	assert.match(text(images.note), /needs Cache → Purge too, and its cache rule \(Performance page\) Cache Settings → Edit\..*one named just Cache and one named Cache Settings/);
});

test("nothing names the permissions the way older editors did", () => {
	const root = new URL("../", import.meta.url).pathname;
	const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : /\.(tsx?|md|astro)$/.test(name) ? [join(dir, name)] : []));
	const old = /(?<!Zone )Transform Rules\s*→|Cache Rules\s*→|Cache Purge\s*→/;
	for (const file of [...files(join(root, "src")), ...files(join(root, "docs")), join(root, "README.md")]) {
		assert.doesNotMatch(readFileSync(file, "utf8"), old, file);
	}
});

test("a refused call names the permission as the editor shows it", async () => {
	const { purgeHost, readMediaCacheRule, applyMediaCacheRule } = await import("../src/images/cloudflare.ts");
	// The zone lookup works; everything else is refused, as with a token missing the permission.
	const fetch = async (url) =>
		String(url).includes("/zones?name=")
			? new Response(JSON.stringify({ success: true, result: [{ id: "z1", name: new URL(url).searchParams.get("name") }] }), { status: 200 })
			: new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
	const config = { token: "tok", accountId: "a".repeat(32), fetch };
	await assert.rejects(purgeHost(config, "media.coywolf.com"), /The Cloudflare API token needs Zone → Cache → Purge\.$/);
	await assert.rejects(readMediaCacheRule(config, "media.coywolf.com"), /The Cloudflare API token needs Zone → Cache Settings → Edit\.$/);
	await assert.rejects(applyMediaCacheRule(config, "media.coywolf.com"), /The Cloudflare API token needs Zone → Cache Settings → Edit\.$/);
});

test("module guides say what the Cloudflare API token needs there, using only permissions the token's guide covers", () => {
	const names = Object.values(CLOUDFLARE_PERMISSIONS).map((p) => p.name);
	for (const id of FEATURE_GUIDES) {
		const plain = text(GUIDES[id].steps.join(" "));
		const step = GUIDES[id].steps.find((s) => s.includes("Here it needs"));
		assert.ok(step, `${id} says what it needs`);
		// A child list (three or more), or "A" / "A and B" inline.
		const lists = childLists(step);
		const needs = lists.length ? lists[0].map(strongName) : text(step).match(/Here it needs (.+?)\./)[1].split(/, | and /);
		assert.ok(needs.length > 0, id);
		for (const permission of needs) assert.ok(names.includes(permission), `${id} needs "${permission}", which the Cloudflare API token's guide doesn't cover`);
		assert.match(plain, /Cloudflare API token from the plugin's Settings page/, id);
		assert.match(plain, /Permission policies/, id);
		assert.doesNotMatch(plain, /Under Account Resources|Under Zone Resources/, id);
	}
});

test("admin pages use the one form: no page builds a token form of its own", () => {
	const src = new URL("../src/", import.meta.url).pathname;
	const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : /\.tsx?$/.test(name) ? [join(dir, name)] : []));
	for (const file of files(src)) {
		if (file.endsWith("core/guide-content.ts")) continue;
		assert.doesNotMatch(readFileSync(file, "utf8"), /tokenFormUrl\(/, `${file} builds its own pre-filled token form`);
	}
});

test("the docs' permission table is the token's: same permissions, policies and what's pre-filled", () => {
	const doc = readFileSync(new URL("../docs/README.md", import.meta.url), "utf8");
	const section = doc.slice(doc.indexOf("## The Cloudflare API token"), doc.indexOf("## Moving to EmDash"));
	const rows = [...section.matchAll(/^\| ([^|]+→[^|]+) \| (Entire Account|This site's domain) \| (Yes|By hand) \|/gm)].map((m) => [m[1].trim(), m[2] === "Entire Account" ? "account" : "zone", m[3] === "Yes"]);
	assert.deepEqual(rows, Object.values(CLOUDFLARE_PERMISSIONS).map((p) => [p.name, p.scope, Boolean(p.form)]));
});

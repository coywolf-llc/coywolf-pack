#!/usr/bin/env node
// Link a byline to a user account, so that user's posts and pages carry the
// byline by default. EmDash 1.2.0 credits an entry with no byline picked to
// the byline linked to its author (the user who created it): the editor shows
// it as "Automatic", and the site renders it like a picked byline. It's the
// same as choosing the user under Content → Bylines → the byline.
//
//   node scripts/byline-link-user.mjs --url=https://example.com [--byline=<slug>] [--user=<id or email>] [--apply] [--purge-cache]
//
// Dry run by default: finds the user (--user, else the site's only admin) and
// the byline (--byline, else the one named like the user), shows the change
// and which entries would start showing the byline, and writes nothing. With
// --apply it saves the byline through EmDash's admin API (user set, guest
// off) and reads it back. EmDash's PUT clears bio, avatar and website when
// they're left out, so the byline's own values are sent back with it.
//
// Pages already in the edge cache keep showing no byline on those entries
// until they expire: --purge-cache clears the pack's page cache afterwards
// (Coywolf Pack → Performance → Clear cache does the same).
//
// Auth: EMDASH_TOKEN, else the EmDash CLI login for the URL in
// ~/.config/emdash/auth.json (`npx emdash login --url <site>`), refreshed when
// it has expired.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = args.includes("--apply");
const purge = args.includes("--purge-cache");
const site = (option("url") || process.env.EMDASH_URL || "").replace(/\/+$/, "");
if (!site) {
	console.error("Usage: node scripts/byline-link-user.mjs --url=<site> [--byline=<slug>] [--user=<id or email>] [--apply] [--purge-cache]");
	process.exit(1);
}
const API = `${site}/_emdash/api`;
const ADMIN = 50;

// ── Auth ─────────────────────────────────────────────────────────

const authFile = join(homedir(), ".config", "emdash", "auth.json");
let token = process.env.EMDASH_TOKEN || "";
if (!token) {
	const all = JSON.parse(await readFile(authFile, "utf8").catch(() => "{}"));
	const cred = all[site];
	if (!cred) {
		console.error(`No EmDash login for ${site}. Run: npx emdash login --url ${site}`);
		process.exit(1);
	}
	token = cred.accessToken;
	if (!(new Date(cred.expiresAt).getTime() > Date.now() + 60_000)) {
		const res = await fetch(`${API}/oauth/token/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ grant_type: "refresh_token", refresh_token: cred.refreshToken }),
		});
		if (!res.ok) {
			console.error(`Token refresh failed (${res.status}). Run: npx emdash login --url ${site}`);
			process.exit(1);
		}
		const json = await res.json();
		const t = json.data?.access_token ? json.data : json;
		token = t.access_token;
		all[site] = {
			...cred,
			accessToken: t.access_token,
			refreshToken: t.refresh_token ?? cred.refreshToken,
			expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
		};
		await writeFile(authFile, JSON.stringify(all, null, 2));
	}
}

async function call(method, path, body) {
	const headers = { Authorization: `Bearer ${token}`, "X-EmDash-Request": "1", Origin: new URL(site).origin };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const json = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.error?.message ?? ""}`.trim());
	return json && typeof json === "object" && "data" in json ? json.data : json;
}

/** Every page of a list endpoint ({ items, nextCursor }). */
async function all(path) {
	const items = [];
	let cursor;
	do {
		const sep = path.includes("?") ? "&" : "?";
		const page = await call("GET", `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
		items.push(...(page.items ?? []));
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}

const fail = (message) => {
	console.error(message);
	process.exit(1);
};

// ── Plan ─────────────────────────────────────────────────────────

const users = await all("/admin/users");
const userArg = option("user");
let user;
if (userArg) {
	user = users.find((u) => u.id === userArg || u.email?.toLowerCase() === userArg.toLowerCase());
	if (!user) fail(`No user ${userArg} on ${site}.`);
} else {
	const admins = users.filter((u) => u.role >= ADMIN && !u.disabled);
	if (admins.length !== 1) fail(`${admins.length} admins on ${site}; pick one with --user=<id>:\n${admins.map((u) => `  ${u.id}  ${u.name ?? ""}`).join("\n")}`);
	user = admins[0];
}

const bylines = await all("/admin/bylines");
const bylineArg = option("byline");
let byline;
if (bylineArg) {
	byline = bylines.find((b) => b.slug === bylineArg || b.id === bylineArg);
	if (!byline) fail(`No byline ${bylineArg} on ${site}.`);
} else {
	const named = bylines.filter((b) => user.name && b.displayName.trim().toLowerCase() === user.name.trim().toLowerCase());
	if (named.length !== 1) {
		fail(`${named.length} bylines named "${user.name ?? ""}" on ${site}; pick one with --byline=<slug>:\n${bylines.map((b) => `  ${b.slug}  ${b.displayName}${b.userId ? " (linked)" : ""}`).join("\n")}`);
	}
	byline = named[0];
}

const other = bylines.find((b) => b.userId === user.id && b.id !== byline.id);
if (other) fail(`${user.name ?? user.id} is already linked to the byline ${other.slug} (${other.displayName}); a user has one byline. Unlink it there first.`);

console.log(`${site}`);
console.log(`  user:   ${user.name ?? ""} (${user.id})`);
console.log(`  byline: ${byline.displayName} (${byline.slug}, ${byline.id}) user=${byline.userId ?? "none"} guest=${byline.isGuest}`);

if (byline.userId === user.id && !byline.isGuest) {
	console.log("Already linked; nothing to do.");
	process.exit(0);
}
if (byline.userId && byline.userId !== user.id) fail(`The byline is linked to another user (${byline.userId}); change it in the admin if that's intended.`);

// Entries with no byline picked that this user created: they show the byline once it's linked.
const collections = (await call("GET", "/schema/collections")).items ?? [];
let total = 0;
for (const c of collections) {
	const items = await all(`/content/${encodeURIComponent(c.slug)}?status=all&bylines=none&authorId=${encodeURIComponent(user.id)}`);
	total += items.length;
	for (const item of items) console.log(`  + ${c.slug}/${item.slug ?? item.id} (${item.status}) will show ${byline.displayName}`);
}
console.log(`  ${total} ${total === 1 ? "entry" : "entries"} with no byline picked will show it automatically.`);

const body = {
	slug: byline.slug,
	displayName: byline.displayName,
	bio: byline.bio ?? null,
	avatarMediaId: byline.avatarMediaId ?? null,
	websiteUrl: byline.websiteUrl ?? null,
	userId: user.id,
	isGuest: false,
};
console.log(`  PUT /_emdash/api/admin/bylines/${byline.id} ${JSON.stringify(body)}`);

if (!apply) {
	console.log("Dry run: nothing changed. Run again with --apply to link.");
	process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────

await call("PUT", `/admin/bylines/${encodeURIComponent(byline.id)}`, body);
const after = await call("GET", `/admin/bylines/${encodeURIComponent(byline.id)}`);
const saved = after?.item ?? after;
const changed = ["slug", "displayName", "bio", "avatarMediaId", "websiteUrl"].filter((k) => (saved?.[k] ?? null) !== (byline[k] ?? null));
if (saved?.userId !== user.id || saved?.isGuest !== false || changed.length) {
	fail(`Saved, but the byline reads back differently: ${JSON.stringify(saved)}`);
}
console.log(`Linked: ${byline.displayName} → ${user.name ?? user.id}.`);

if (purge) {
	try {
		const result = await call("POST", "/plugins/coywolf-pack/cache/purge");
		console.log(`Page cache cleared: ${JSON.stringify(result)}`);
	} catch (error) {
		console.log(`Page cache not cleared: ${error.message}`);
	}
}

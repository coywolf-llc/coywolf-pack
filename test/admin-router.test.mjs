// Run: node --test test/admin-router.test.mjs
//
// The unsaved-changes guard and in-admin links (src/admin/router.ts), against a
// stand-in for TanStack's history that runs blockers the way @tanstack/history does:
// one after another, awaited, and a navigation goes ahead only when none blocks it.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { adminRouter, adminHref, goTo, guardNavigation, isPlainClick, packPagePath } = await import("../src/admin/router.ts");

function fakeRouter(basepath = "/_emdash/admin") {
	const blockers = [];
	const navigated = [];
	let location = { pathname: "/_emdash/admin/plugins/coywolf-pack/schema", search: "", hash: "" };
	return {
		options: { basepath },
		navigated,
		get blockers() {
			return blockers;
		},
		history: {
			block(blocker) {
				blockers.push(blocker);
				return () => blockers.splice(blockers.indexOf(blocker), 1);
			},
		},
		navigate(options) {
			navigated.push(options.to);
		},
		/** A navigation to `pathname` (PUSH unless said otherwise): true when it went ahead. */
		async go(pathname, action = "PUSH", search = "") {
			const nextLocation = { pathname, search, hash: "", href: `${pathname}${search}` };
			for (const blocker of [...blockers]) {
				if (await blocker.blockerFn({ currentLocation: location, nextLocation, action })) return false;
			}
			location = nextLocation;
			return true;
		},
	};
}

test("the admin's router is found on window.__TSR_ROUTER__, and only the admin's", () => {
	const router = fakeRouter();
	assert.equal(adminRouter({ __TSR_ROUTER__: router }), router);
	assert.equal(adminRouter({ __TSR_ROUTER__: fakeRouter("/_emdash/admin/") }) !== null, true, "a trailing slash on the basepath is the same admin");
	assert.equal(adminRouter({}), null, "no router: links and the guard fall back");
	assert.equal(adminRouter({ __TSR_ROUTER__: fakeRouter("/app") }), null, "another app's router isn't used");
	assert.equal(adminRouter({ __TSR_ROUTER__: { navigate() {} } }), null, "something without history.block isn't a router");
});

test("Stay blocks the navigation; Leave lets it through", async () => {
	const router = fakeRouter();
	const asked = [];
	let answer = false;
	const release = guardNavigation(router, async (next) => {
		asked.push(next.pathname);
		return answer;
	});
	assert.equal(await router.go("/_emdash/admin/plugins/coywolf-pack/features"), false, "Stay");
	answer = true;
	assert.equal(await router.go("/_emdash/admin/plugins/coywolf-pack/features"), true, "Leave");
	assert.deepEqual(asked, ["/_emdash/admin/plugins/coywolf-pack/features", "/_emdash/admin/plugins/coywolf-pack/features"]);
	release();
	assert.equal(router.blockers.length, 0, "released once the page is saved, discarded or left");
});

test("Back and Forward are asked about too; a change of query or hash on the same page isn't", async () => {
	const router = fakeRouter();
	let asked = 0;
	guardNavigation(router, async () => {
		asked++;
		return false;
	});
	assert.equal(await router.go("/_emdash/admin/content/posts", "BACK"), false);
	assert.equal(await router.go("/_emdash/admin/plugins/coywolf-pack/schema", "REPLACE", "?tab=types"), true, "same path: not blocked");
	assert.equal(asked, 1);
});

test("several guards on one page ask once: Leave on the first lets the same navigation through the others", async () => {
	const router = fakeRouter();
	let asked = 0;
	const ask = async () => {
		asked++;
		return true;
	};
	guardNavigation(router, ask);
	guardNavigation(router, ask);
	assert.equal(await router.go("/_emdash/admin/settings"), true);
	assert.equal(asked, 1);
	// The answer doesn't carry over to a later navigation.
	await new Promise((resolve) => setTimeout(resolve, 5));
	await router.go("/_emdash/admin/plugins/coywolf-pack/schema");
	assert.equal(asked, 2);
});

test("in-admin links: paths, plain clicks, and going there through the router or a page load", () => {
	assert.equal(packPagePath("/features"), "/plugins/coywolf-pack/features");
	assert.equal(packPagePath("links"), "/plugins/coywolf-pack/links");
	assert.equal(adminHref("/plugins/coywolf-pack/features"), "/_emdash/admin/plugins/coywolf-pack/features");

	const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
	assert.equal(isPlainClick(click), true);
	for (const change of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
		assert.equal(isPlainClick({ ...click, ...change }), false, JSON.stringify(change));
	}

	const router = fakeRouter();
	goTo("/redirects", { __TSR_ROUTER__: router });
	assert.deepEqual(router.navigated, ["/redirects"]);
	const loads = [];
	goTo("/redirects", { location: { assign: (url) => loads.push(url) } });
	assert.deepEqual(loads, ["/_emdash/admin/redirects"]);
});

/**
 * Update check (pure part): version comparison and the notice's fixed text.
 * No imports, so `node --test` can load this file.
 */

export const PACKAGE_NAME = "@coywolf/emdash";
export const NPM_HOST = "registry.npmjs.org";
/** npm's dist-tags for the package: a few bytes (`{"latest":"0.35.14"}`). */
export const DIST_TAGS_URL = `https://${NPM_HOST}/-/package/%40coywolf%2Femdash/dist-tags`;
export const RELEASES_URL = "https://github.com/coywolf-llc/coywolf-pack/releases";
export const UPDATE_COMMAND = `npm install ${PACKAGE_NAME}@latest`;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version npm could have given (x.y.z, optionally -prerelease and +build), or null. */
export function parseVersion(value: unknown): { core: [number, number, number]; pre: string | null } | null {
	if (typeof value !== "string") return null;
	const m = SEMVER.exec(value.trim());
	if (!m) return null;
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

function comparePre(a: string, b: string): number {
	const x = a.split(".");
	const y = b.split(".");
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if (x[i] === undefined) return -1;
		if (y[i] === undefined) return 1;
		const nx = /^\d+$/.test(x[i]) ? Number(x[i]) : null;
		const ny = /^\d+$/.test(y[i]) ? Number(y[i]) : null;
		if (nx !== null && ny !== null) {
			if (nx !== ny) return nx < ny ? -1 : 1;
		} else if (nx !== null) return -1;
		else if (ny !== null) return 1;
		else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	}
	return 0;
}

/** Semver order: -1, 0 or 1. Null when either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
	if (x.pre === y.pre) return 0;
	// A release is newer than its prereleases.
	if (x.pre === null) return 1;
	if (y.pre === null) return -1;
	return comparePre(x.pre, y.pre);
}

/** True when `latest` is a newer version than `current`. */
export function isNewer(latest: string | null | undefined, current: string): boolean {
	return typeof latest === "string" && compareVersions(latest, current) === 1;
}

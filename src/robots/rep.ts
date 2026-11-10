/**
 * Robots Exclusion Protocol (RFC 9309) evaluator: a TypeScript port of
 * Google's open-source robots.txt parser and matcher
 * (https://github.com/google/robotstxt), by way of Coywolf SEO's PHP port.
 *
 * - `matchRaw` is RobotsMatchStrategy::Matches(): `*` matches any run of
 *   bytes, a final `$` anchors the end, everything else is literal. Linear,
 *   no backtracking, so hostile patterns can't cause ReDoS.
 * - `parse` is RobotsTxtParser: BOM skipping, \n / \r / \r\n lines, `#`
 *   comments, missing-colon recovery, Google's key typos, the 16,664-byte
 *   line cap, and percent-normalization of Allow/Disallow values.
 * - `evaluate` is RobotsMatcher: groups per user-agent (every group naming
 *   the agent is merged, as RFC 9309 §2.2.1 requires), the specific group
 *   shadows `*`, longest match wins, and Allow wins ties.
 *
 * Google works on bytes, so inputs are converted to a "byte string" (one
 * char per UTF-8 byte) first; that keeps lengths and the non-ASCII escaping
 * identical to the reference implementation.
 *
 * This file has no imports so the tests can run it under plain Node.
 */

const MAX_LINE_LEN = 2083 * 8;

/** One char per UTF-8 byte (chars ≤ 0xFF pass through unchanged when already bytes). */
export function toBytes(input: string): string {
	// Already a byte string (e.g. the output of this function)? Leave it.
	// Control characters in the pattern: byte range check.
	if (!/[^\u0000-\u007f]/.test(input)) return input;
	const bytes = new TextEncoder().encode(input);
	let out = "";
	for (const b of bytes) out += String.fromCharCode(b);
	return out;
}

const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);

/**
 * MaybeEscapePattern(): uppercase existing %xx escapes and percent-encode
 * bytes with the high bit set. Expects a byte string.
 */
export function escapePattern(s: string): string {
	let need = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "%" && i + 2 < s.length && isHex(s[i + 1]) && isHex(s[i + 2])) {
			if (/[a-f]/.test(s[i + 1]) || /[a-f]/.test(s[i + 2])) need = true;
			i += 2;
		} else if (s.charCodeAt(i) & 0x80) need = true;
	}
	if (!need) return s;
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "%" && i + 2 < s.length && isHex(s[i + 1]) && isHex(s[i + 2])) {
			out += `%${s[i + 1].toUpperCase()}${s[i + 2].toUpperCase()}`;
			i += 2;
		} else if (s.charCodeAt(i) & 0x80) {
			out += `%${s.charCodeAt(i).toString(16).toUpperCase().padStart(2, "0")}`;
		} else out += c;
	}
	return out;
}

/** The raw REP wildcard match (no normalization), anchored at the start of the path. */
export function matchRaw(pattern: string, path: string): boolean {
	const pathlen = path.length;
	const pos: number[] = [0];
	let numpos = 1;
	for (let pi = 0; pi < pattern.length; pi++) {
		const pc = pattern[pi];
		if (pc === "$" && pi + 1 === pattern.length) return pos[numpos - 1] === pathlen;
		if (pc === "*") {
			numpos = pathlen - pos[0] + 1;
			for (let i = 1; i < numpos; i++) pos[i] = pos[i - 1] + 1;
		} else {
			let next = 0;
			for (let i = 0; i < numpos; i++) {
				if (pos[i] < pathlen && path[pos[i]] === pc) pos[next++] = pos[i] + 1;
			}
			numpos = next;
			if (numpos === 0) return false;
		}
	}
	return true;
}

/** Pattern vs path with both sides normalized (for author-entered values, e.g. the rule tester). */
export function matches(pattern: string, path: string): boolean {
	return matchRaw(escapePattern(toBytes(pattern)), escapePattern(toBytes(path)));
}

/** GetPathParamsQuery(): path + params + query of a URL (no scheme, host or fragment); always starts with "/". */
export function pathParamsQuery(input: string): string {
	const url = toBytes(input);
	const n = url.length;
	const NPOS = Number.MAX_SAFE_INTEGER;
	const findFirstOf = (chars: string, from: number) => {
		for (let i = from; i < n; i++) if (chars.includes(url[i])) return i;
		return NPOS;
	};
	const searchStart = n >= 2 && url[0] === "/" && url[1] === "/" ? 2 : 0;
	const earlyPath = findFirstOf("/?;", searchStart);
	const proto = url.indexOf("://", searchStart);
	let protocolEnd = proto === -1 ? NPOS : proto;
	if (earlyPath < protocolEnd) protocolEnd = NPOS;
	protocolEnd = protocolEnd === NPOS ? searchStart : protocolEnd + 3;

	const pathStart = findFirstOf("/?;", protocolEnd);
	if (pathStart === NPOS) return "/";
	const hash = url.indexOf("#", searchStart);
	const hashPos = hash === -1 ? NPOS : hash;
	if (hashPos < pathStart) return "/";
	const pathEnd = hashPos === NPOS ? n : hashPos;
	const out = url.slice(pathStart, pathEnd);
	return url[pathStart] === "/" ? out : `/${out}`;
}

/** ExtractUserAgent(): the leading run of [a-zA-Z_-]. */
export function extractUserAgent(userAgent: string): string {
	const m = /^[a-zA-Z_-]*/.exec(userAgent);
	return m ? m[0] : "";
}

/** IsValidUserAgentToObey(): non-empty and only [a-zA-Z_-]. */
export function isValidUserAgentToObey(userAgent: string): boolean {
	return userAgent.length > 0 && extractUserAgent(userAgent) === userAgent;
}

export type DirectiveType = "user-agent" | "allow" | "disallow" | "sitemap" | "unknown";

export interface Directive {
	line: number;
	type: DirectiveType;
	key: string;
	value: string;
}

function keyType(key: string): DirectiveType {
	const k = key.toLowerCase();
	const starts = (p: string) => k.startsWith(p);
	if (starts("user-agent") || starts("useragent") || starts("user agent")) return "user-agent";
	if (starts("allow")) return "allow";
	if (["disallow", "dissallow", "dissalow", "disalow", "diasllow", "disallaw"].some(starts)) return "disallow";
	if (starts("sitemap") || starts("site-map")) return "sitemap";
	return "unknown";
}

const WS = " \t\n\v\f\r";
const trimWs = (s: string) => {
	let a = 0;
	let b = s.length;
	while (a < b && WS.includes(s[a])) a++;
	while (b > a && WS.includes(s[b - 1])) b--;
	return s.slice(a, b);
};

function parseLine(raw: string, lineNum: number): Directive | null {
	let line = raw;
	const hash = line.indexOf("#");
	if (hash !== -1) line = line.slice(0, hash);
	line = trimWs(line);
	if (!line) return null;

	let sep = line.indexOf(":");
	if (sep === -1) {
		// Missing-colon recovery: exactly two whitespace-separated tokens.
		const ws = line.search(/[ \t]/);
		if (ws === -1) return null;
		let valStart = ws;
		while (valStart < line.length && (line[valStart] === " " || line[valStart] === "\t")) valStart++;
		if (/[ \t]/.test(line.slice(valStart))) return null;
		sep = ws;
	}
	const key = trimWs(line.slice(0, sep));
	if (!key) return null;
	let value = trimWs(line.slice(sep + 1));
	const type = keyType(key);
	if (type === "allow" || type === "disallow") value = escapePattern(value);
	return { line: lineNum, type, key, value };
}

/** Parse a robots.txt body into directives (Google's tolerances included). */
export function parse(input: string): { lines: number; directives: Directive[] } {
	const body = toBytes(input);
	const BOM = "\xEF\xBB\xBF";
	const directives: Directive[] = [];
	let line = "";
	let lineNum = 0;
	let bomPos = 0;
	let lastCr = false;
	const emit = (raw: string) => {
		const d = parseLine(raw, ++lineNum);
		if (d) directives.push(d);
	};
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (bomPos < 3) {
			const expected = BOM[bomPos++];
			if (ch === expected) continue;
			bomPos = 3;
		}
		if (ch !== "\n" && ch !== "\r") {
			if (line.length < MAX_LINE_LEN - 1) line += ch;
		} else {
			const crlfContinuation = line === "" && lastCr && ch === "\n";
			if (!crlfContinuation) emit(line);
			line = "";
			lastCr = ch === "\r";
		}
	}
	emit(line);
	return { lines: lineNum, directives };
}

type Match = { priority: number; line: number; value: string };
const NO_MATCH: Match = { priority: -1, line: 0, value: "" };

export interface Verdict {
	allowed: boolean;
	/** The path that was evaluated (path + query). */
	path: string;
	/** Which directive decided it ("none" when no rule matched). */
	matchedDirective: "allow" | "disallow" | "none";
	matchedValue: string;
	/** 1-based line number in the robots.txt, 0 when none. */
	matchedLine: number;
	/** Whether the agent's own group(s) or the `*` group applied. */
	scope: "specific" | "global";
}

/** Evaluate a URL against a whole robots.txt for one or more user-agent tokens. */
/**
 * The product token at the start of a `User-agent:` value, for matching
 * directory tokens: Google's ExtractUserAgent() stops at the first byte
 * outside [a-zA-Z_-] ("MJ12bot" → "MJ"), which suits callers that pass
 * pre-extracted tokens; this accepts digits and dots too so tokens such as
 * MJ12bot or archive.org_bot match their own groups.
 */
export function extractProductToken(userAgent: string): string {
	const m = /^[A-Za-z0-9._-]*/.exec(userAgent);
	return m ? m[0] : "";
}

/**
 * Percent-encode a request path the way patterns are (non-ASCII bytes, spaces
 * and controls; %xx hex uppercased). Expects a byte string (see toBytes).
 */
export function normalizePath(bytes: string): string {
	// Control characters in the pattern: encoding control bytes.
	return escapePattern(bytes).replace(/[\u0000-\u0020\u007f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export interface EvaluateOptions {
	/**
	 * Percent-encode the request path like a crawler sends it (default false,
	 * which is Google's contract: the caller passes an already-encoded URL).
	 * The admin tester turns this on so a typed "/café" means "/caf%C3%A9".
	 */
	encodePath?: boolean;
}

export function evaluate(body: string, userAgents: string[], url: string, options: EvaluateOptions = {}): Verdict {
	return evaluateParsed(parse(body).directives, userAgents, url, options);
}

/** evaluate() over directives already returned by parse(), for callers that test many URLs against one file. */
export function evaluateParsed(directives: Directive[], userAgents: string[], url: string, options: EvaluateOptions = {}): Verdict {
	const rawPath = pathParamsQuery(url);
	const path = options.encodePath ? normalizePath(rawPath) : rawPath;

	let allowGlobal = NO_MATCH;
	let allowSpecific = NO_MATCH;
	let disGlobal = NO_MATCH;
	let disSpecific = NO_MATCH;
	let seenGlobal = false;
	let seenSpecific = false;
	let everSpecific = false;
	let seenSeparator = false;

	const record = (kind: "allow" | "disallow", value: string, line: number): boolean => {
		const priority = matchRaw(value, path) ? value.length : -1;
		if (priority < 0) return false;
		const m = { priority, line, value };
		if (kind === "allow") {
			if (seenSpecific) {
				if (allowSpecific.priority < priority) allowSpecific = m;
			} else if (allowGlobal.priority < priority) allowGlobal = m;
		} else if (seenSpecific) {
			if (disSpecific.priority < priority) disSpecific = m;
		} else if (disGlobal.priority < priority) disGlobal = m;
		return true;
	};

	const handleAllow = (value: string, line: number) => {
		if (record("allow", value, line)) return;
		// Google treats an Allow of ".../index.htm(l)" as also allowing the directory itself.
		const slash = value.lastIndexOf("/");
		if (slash !== -1 && value.slice(slash).startsWith("/index.htm")) handleAllow(`${value.slice(0, slash + 1)}$`, line);
	};

	for (const d of directives) {
		if (d.type === "user-agent") {
			if (seenSeparator) {
				seenSpecific = false;
				seenGlobal = false;
				seenSeparator = false;
			}
			const v = d.value;
			if (v.length >= 1 && v[0] === "*" && (v.length === 1 || WS.includes(v[1]))) {
				seenGlobal = true;
			} else {
				const token = extractProductToken(v);
				if (token && userAgents.some((qa) => qa.toLowerCase() === token.toLowerCase())) {
					everSpecific = true;
					seenSpecific = true;
				}
			}
			continue;
		}
		if (d.type !== "allow" && d.type !== "disallow") continue;
		if (!(seenGlobal || seenSpecific)) continue;
		seenSeparator = true;
		if (d.type === "allow") handleAllow(d.value, d.line);
		else record("disallow", d.value, d.line);
	}

	let scope: Verdict["scope"] = "global";
	let disPick = disGlobal;
	let allowPick = allowGlobal;
	let disallow = false;
	if (allowSpecific.priority > 0 || disSpecific.priority > 0) {
		scope = "specific";
		disPick = disSpecific;
		allowPick = allowSpecific;
		disallow = disSpecific.priority > allowSpecific.priority;
	} else if (everSpecific) {
		scope = "specific";
		disPick = NO_MATCH;
		allowPick = NO_MATCH;
	} else if (disGlobal.priority > 0 || allowGlobal.priority > 0) {
		disallow = disGlobal.priority > allowGlobal.priority;
	}

	let matchedDirective: Verdict["matchedDirective"] = "none";
	let matched = NO_MATCH;
	if (disPick.priority > 0 || allowPick.priority > 0) {
		if (disPick.priority > allowPick.priority) {
			matchedDirective = "disallow";
			matched = disPick;
		} else {
			matchedDirective = "allow";
			matched = allowPick;
		}
	}
	return { allowed: !disallow, path, matchedDirective, matchedValue: matched.value, matchedLine: matched.line, scope };
}

/** OneAgentAllowedByRobots(). */
export function oneAgentAllowed(body: string, userAgent: string, url: string): boolean {
	return evaluate(body, [userAgent], url).allowed;
}

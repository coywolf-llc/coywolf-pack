/**
 * What the pack's rate limits (search, video plays and likes) share: the
 * Workers Rate Limiting binding they use when the site has one, and how a
 * visitor's address becomes the key they count by. No imports, so tests can
 * load it.
 *
 * The binding (wrangler.jsonc "ratelimits") counts across every isolate in a
 * Cloudflare location, which the pack's per-isolate memory counters can't:
 * Workers spread a visitor's requests over many short-lived isolates. One
 * binding serves every limit, each with keys of its own ("search:…",
 * "play:…", "like:…"), at the limit the binding sets. See docs/performance.md.
 */

/** The binding name the pack looks for when no other is configured. */
export const DEFAULT_RATE_LIMITER = "COYWOLF_RATE_LIMITER";

/** The Workers Rate Limiting binding's API. */
export interface RateLimitBinding {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The binding named `name` (default DEFAULT_RATE_LIMITER) in the Worker's env, if it's there. */
export function rateLimitBinding(env: Record<string, unknown>, name: string = DEFAULT_RATE_LIMITER): RateLimitBinding | undefined {
	const binding = env[name] as Partial<RateLimitBinding> | undefined;
	return binding && typeof binding.limit === "function" ? (binding as RateLimitBinding) : undefined;
}

/**
 * Whether the binding lets one more request for `key` through. True when
 * there's no binding (the caller's memory counter decides) or the binding
 * fails (the memory counter still applies; a broken binding mustn't block
 * every visitor).
 */
export async function bindingAllows(binding: RateLimitBinding | undefined, key: string): Promise<boolean> {
	if (!binding) return true;
	try {
		return (await binding.limit({ key })).success;
	} catch {
		return true;
	}
}

/** The groups of an IPv6 address, `::` expanded (null when it isn't one). */
function ipv6Groups(ip: string): string[] | null {
	const halves = ip.split("::");
	if (halves.length > 2) return null;
	// An embedded IPv4 address (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) takes two groups.
	const parts = (half: string) =>
		half
			? half.split(":").flatMap((part) => {
					if (!part.includes(".")) return [part];
					const octets = part.split(".").map(Number);
					if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return ["x"];
					return [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
				})
			: [];
	const left = parts(halves[0]);
	const right = halves.length === 2 ? parts(halves[1]) : [];
	const groups = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	return groups.map((g) => Number.parseInt(g, 16).toString(16));
}

/**
 * The part of a visitor's address the limits count by: an IPv4 address as
 * is, an IPv6 address by its /64. One connection gets a whole /64 (often
 * 2^64 addresses to choose from), so counting full IPv6 addresses let one
 * visitor be any number of visitors. An IPv4-mapped IPv6 address counts as
 * its IPv4 address.
 */
export function addressKey(raw: string): string {
	const ip = raw.trim().toLowerCase().replace(/%.*$/, "");
	if (!ip.includes(":")) return ip;
	const groups = ipv6Groups(ip);
	if (!groups) return ip;
	if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
		const [hi, lo] = [Number.parseInt(groups[6], 16), Number.parseInt(groups[7], 16)];
		return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
	}
	return `${groups.slice(0, 4).join(":")}::/64`;
}

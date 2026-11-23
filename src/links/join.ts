/**
 * Join split links (content:beforeSave, the `links.join` part of Link Manager).
 *
 * EmDash's editor sometimes saves one link as two adjacent spans, each with its
 * own link mark definition for the same address: "Google's " and "Gemini" both
 * linking to https://glossary.io/gemini/, through markDefs `a1` and `b2`. That
 * renders as two `<a>` elements side by side, so hover styles apply a word at a
 * time, screen readers announce two links, and link tooltips (glossary.io's)
 * see two links.
 *
 * In every run of spans (a text block's `children`, a table cell's `content`,
 * at any depth, so blocks nested in other blocks' fields too), a span whose one
 * link mark has the same address and the same other attributes as the previous
 * span's link mark is re-pointed to that mark. Link mark definitions no span
 * uses any more are dropped. Text, other marks, keys, blocks and their order are
 * never changed, and definitions that were unused before stay as they were.
 *
 * The joined pieces then render as one `<a>`, except where other formatting
 * starts before the link and ends inside it ("pre " and "G " bold, then "Gem"):
 * EmDash's renderer (astro-portabletext, @portabletext/toolkit buildMarksTree)
 * closes the link with the bold, as it does for any link of that shape.
 * Spans that use a table's own markDefs (not their cell's) aren't joined.
 *
 * Pure: never mutates its input; changed objects are copied and unchanged
 * subtrees are shared. Running it twice gives the same result (nothing joined
 * the second time).
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The keys that hold a run of spans next to a `markDefs` array: text blocks and table cells. */
const SPAN_RUNS = ["children", "content"] as const;

/** JSON with object keys sorted, so attribute order doesn't matter. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObj(value)) {
		return `{${Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * What a link mark definition renders as: its address and every other attribute
 * but its key. `blank` counts by truthiness (EmDash's link mark opens a new tab
 * when it's truthy), so `blank: false` and no `blank` are the same link. Null
 * for anything that isn't a link with an address.
 */
function linkIdentity(def: Obj): string | null {
	if (def._type !== "link" || typeof def.href !== "string" || !def.href) return null;
	const rest: Obj = {};
	for (const [k, v] of Object.entries(def)) if (k !== "_key" && k !== "blank") rest[k] = v;
	rest.blank = Boolean(def.blank);
	return canonical(rest);
}

/** Every mark key the spans under `node` (outside markDefs) use, in one pass. */
function marksInUse(node: unknown, out = new Set<unknown>()): Set<unknown> {
	if (Array.isArray(node)) {
		for (const item of node) marksInUse(item, out);
		return out;
	}
	if (!isObj(node)) return out;
	if (node._type === "span") {
		if (Array.isArray(node.marks)) for (const mark of node.marks) out.add(mark);
		return out;
	}
	for (const [k, child] of Object.entries(node)) {
		if (k !== "markDefs" && typeof child === "object" && child !== null) marksInUse(child, out);
	}
	return out;
}

/**
 * Join the split links of one node that has `markDefs` (a text block or a table
 * cell). Returns the new node and how many spans were re-pointed, or null when
 * nothing changed.
 */
function joinNode(node: Obj): { node: Obj; joined: number } | null {
	const markDefs = node.markDefs as unknown[];
	// Link definitions by key. A key defined twice is ambiguous: such links are left as they are.
	const identity = new Map<string, string | null>();
	for (const def of markDefs) {
		if (!isObj(def) || typeof def._key !== "string" || !def._key) continue;
		identity.set(def._key, identity.has(def._key) ? null : linkIdentity(def));
	}
	const linkKey = (key: unknown): key is string => typeof key === "string" && typeof identity.get(key) === "string";

	let next: Obj | null = null;
	let joined = 0;
	const dropped = new Set<string>();
	for (const field of SPAN_RUNS) {
		const run = node[field];
		if (!Array.isArray(run)) continue;
		let items: unknown[] | null = null;
		// The link mark of the span just before, once that span has exactly one link mark.
		let previous: string | null = null;
		for (let index = 0; index < run.length; index++) {
			const item: unknown = run[index];
			const links = isObj(item) && item._type === "span" && Array.isArray(item.marks) ? [...new Set(item.marks.filter(linkKey))] : [];
			if (links.length !== 1) {
				previous = null;
				continue;
			}
			const key = links[0];
			if (previous !== null && key !== previous && identity.get(key) === identity.get(previous)) {
				const span = item as Obj & { marks: unknown[] };
				const to = previous;
				items ??= run.slice();
				items[index] = { ...span, marks: span.marks.map((m) => (m === key ? to : m)) };
				dropped.add(key);
				joined++;
				continue; // `previous` stays: the next span may join the same link.
			}
			previous = key;
		}
		if (items) {
			next ??= { ...node };
			next[field] = items;
		}
	}
	if (!next) return null;

	// Drop the definitions this left unused (still used elsewhere in the node: kept). One walk, whatever the
	// number of joins: a check per dropped key was quadratic (16 s for a 40,000-span block).
	const used = marksInUse({ ...next, markDefs: [] });
	const unused = new Set([...dropped].filter((key) => !used.has(key)));
	if (unused.size) next.markDefs = markDefs.filter((def) => !(isObj(def) && typeof def._key === "string" && unused.has(def._key)));
	return { node: next, joined };
}

export interface JoinResult<T> {
	value: T;
	/** Spans re-pointed to the link before them. */
	joined: number;
}

/** Join split links anywhere in a Portable Text value (or any nested block structure). */
export function joinSplitLinks<T>(value: T): JoinResult<T> {
	let joined = 0;
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) {
			let any = false;
			const items = v.map((item) => {
				const n = walk(item);
				if (n !== item) any = true;
				return n;
			});
			return any ? items : v;
		}
		if (!isObj(v)) return v;
		let next: Obj | null = null;
		// Nested blocks first (a table's cells, a custom block's fields), then this node's own spans.
		for (const [k, child] of Object.entries(v)) {
			if (k === "markDefs" || k === "asset" || typeof child !== "object" || child === null) continue;
			const n = walk(child);
			if (n !== child) {
				next ??= { ...v };
				next[k] = n;
			}
		}
		const current = next ?? v;
		if (Array.isArray(current.markDefs)) {
			const result = joinNode(current);
			if (result) {
				joined += result.joined;
				return result.node;
			}
		}
		return current;
	};
	return { value: walk(value) as T, joined };
}

/**
 * Join split links in every field of an entry's content that holds blocks (or
 * any nested object). Returns the new content and the count, or null when
 * nothing changed. Fields that didn't change are kept as the same values.
 */
export function joinEntrySplitLinks(content: Obj): { content: Obj; joined: number } | null {
	let out: Obj | null = null;
	let joined = 0;
	for (const [field, value] of Object.entries(content)) {
		if (typeof value !== "object" || value === null) continue;
		const result = joinSplitLinks(value);
		if (result.value !== value) {
			out ??= { ...content };
			out[field] = result.value;
			joined += result.joined;
		}
	}
	return out ? { content: out, joined } : null;
}

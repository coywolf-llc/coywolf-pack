/**
 * AI Enrichment: pure logic (no imports, no I/O) so it can be unit tested
 * with `node --test`. Model-output parsing and validation, Wikidata grounding
 * filters, Portable Text → plain text, and queue batching.
 *
 * Ported from Coywolf SEO for WordPress (class-coywolf-seo-ai.php and
 * class-coywolf-seo-image-ai.php): the model extracts entity MENTIONS only
 * (never identifiers); real Wikidata candidates are looked up
 * deterministically; the model may only choose among those candidates; and
 * each chosen item's P31 (instance of) claims are checked against the
 * expected type.
 */

export const ENTITY_TYPES = ["Person", "Organization", "Place", "Thing"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const MAX_ENTITIES = 12;
export const DESCRIPTION_MAX = 155;
export const ALT_MAX = 250;
export const CAPTION_MAX = 300;

/** Q-number of a Wikimedia disambiguation page and of "human". */
const DISAMBIGUATION = "Q4167410";
const HUMAN = "Q5";

/**
 * Common `instance of` classes for creative works and publications. An
 * entity the article calls a Person, Organization, or Place must not resolve
 * to one of these (e.g. the band's album instead of the band).
 */
const CREATIVE_WORKS = new Set([
	"Q7725634", // literary work
	"Q571", // book
	"Q47461344", // written work
	"Q11424", // film
	"Q5398426", // television series
	"Q21191270", // television series episode
	"Q482994", // album
	"Q134556", // single
	"Q7366", // song
	"Q105543609", // musical work/composition
	"Q7889", // video game
	"Q13442814", // scholarly article
	"Q191067", // article
	"Q3305213", // painting
	"Q838948", // work of art
	"Q17537576", // creative work
	"Q87167", // manuscript
	"Q1004", // comics
	"Q25379", // play
	"Q24862", // short film
	"Q506240", // television film
	"Q63952888", // anime television series
	"Q4167836", // Wikimedia category
	"Q11266439", // Wikimedia template
	"Q13406463", // Wikimedia list article
	"Q17633526", // Wikinews article
]);

/** Geographic classes an Organization must not resolve to. */
const GEOGRAPHIC = new Set([
	"Q515", // city
	"Q1549591", // big city
	"Q5119", // capital
	"Q6256", // country
	"Q3624078", // sovereign state
	"Q35657", // U.S. state
	"Q486972", // human settlement
	"Q532", // village
	"Q3957", // town
	"Q23442", // island
	"Q8502", // mountain
	"Q4022", // river
	"Q23397", // lake
	"Q1620908", // historical region
	"Q82794", // geographic region
	"Q5107", // continent
]);

/** Lowercase, strip diacritics and punctuation, collapse whitespace: "Café-Müller, Inc." → "cafe muller inc". */
export function normalizeName(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export interface Mention {
	surface: string;
	name: string;
	type: EntityType;
	description: string;
	primary: boolean;
}

export interface Candidate {
	id: string;
	label: string;
	description: string;
	/** Aliases and the matched text wbsearchentities reports, for the name check. */
	aliases?: string[];
}

export interface GroundedMention extends Mention {
	qid: string;
	candidates: Candidate[];
}

export interface WikidataDetails {
	p31: string[];
	wikipedia: string;
	website: string;
}

/** A stored, verified entity. */
export interface Entity {
	name: string;
	type: EntityType;
	description: string;
	qid: string;
	wikipedia: string;
	website: string;
	primary: boolean;
}

export interface ImageText {
	alt: string;
	caption: string;
	title: string;
}

// ── Model output ─────────────────────────────────────────────────

/** Decode a model response that should be bare JSON, tolerating code fences and leading prose. */
export function decodeJson(text: unknown): unknown {
	if (text !== null && typeof text === "object") return text; // Workers AI may already return parsed JSON.
	let s = String(text ?? "").trim();
	s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	const start = s.search(/[[{]/);
	if (start < 0) return null;
	s = s.slice(start);
	try {
		return JSON.parse(s);
	} catch {
		// Trailing prose after the JSON: cut at the last matching closer.
		const closer = s[0] === "[" ? "]" : "}";
		const end = s.lastIndexOf(closer);
		if (end <= 0) return null;
		try {
			return JSON.parse(s.slice(0, end + 1));
		} catch {
			return null;
		}
	}
}

/** Strip tags and control characters, collapse whitespace, cap length (on code points). */
export function cleanText(value: unknown, max = 500): string {
	if (typeof value !== "string" && typeof value !== "number") return "";
	let s = String(value)
		.replace(/<[^>]*>/g, " ")
		// Control characters in the pattern: stripping control characters is the point.
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const chars = [...s];
	if (chars.length > max) s = chars.slice(0, max).join("").trim();
	return s;
}

/** Parse and sanitize the entity-extraction response (a JSON array of mentions). */
export function parseMentions(text: unknown): Mention[] {
	const rows = decodeJson(text);
	const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" && Array.isArray((rows as { entities?: unknown }).entities) ? (rows as { entities: unknown[] }).entities : null;
	if (!list) return [];
	const out: Mention[] = [];
	const seen = new Set<string>();
	for (const row of list) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const r = row as Record<string, unknown>;
		const name = cleanText(r.name, 120);
		if (!name || !r.type) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const type = (ENTITY_TYPES as readonly string[]).includes(String(r.type)) ? (String(r.type) as EntityType) : "Thing";
		out.push({
			surface: cleanText(r.surface, 120),
			name,
			type,
			description: cleanText(r.description, 200),
			primary: r.primary === true || r.primary === "true",
		});
		if (out.length >= MAX_ENTITIES) break;
	}
	return out;
}

/** Parse the disambiguation response: { "Entity name": "Q123" | null }. */
export function parseChoices(text: unknown): Record<string, string | null> {
	const decoded = decodeJson(text);
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
	const out: Record<string, string | null> = {};
	for (const [name, value] of Object.entries(decoded as Record<string, unknown>)) {
		out[name] = typeof value === "string" && /^Q\d+$/i.test(value.trim()) ? value.trim().toUpperCase() : null;
	}
	return out;
}

/** Normalize a generated meta description: plain single line, no wrapping quotes, ≤ max chars cut on a word. */
export function cleanDescription(text: unknown, max = DESCRIPTION_MAX): string {
	let s = cleanText(typeof text === "string" ? text : "", 2000);
	const unquote = (v: string) => v.replace(/^["'“‘]+|["'”’]+$/gu, "").trim();
	s = unquote(unquote(s).replace(/^(meta description|description)\s*:\s*/i, ""));
	const chars = [...s];
	if (chars.length <= max) return s;
	const cut = chars.slice(0, max - 1).join("");
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, "")}…`;
}

/** Parse the image-text response ({ alt_text, title, caption, description }). Throws when nothing usable came back. */
export function parseImageText(text: unknown): ImageText {
	if (typeof text === "string" && !text.trim()) {
		throw new Error("The AI service returned an empty response (it may have run out of output tokens). Try again, or pick a different model.");
	}
	const fields = decodeJson(text);
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
		throw new Error("The AI service returned a response that could not be parsed. Try again.");
	}
	const f = fields as Record<string, unknown>;
	const alt = cleanText(f.alt_text ?? f.alt, ALT_MAX).replace(/^(an? )?(image|photo|picture|graphic) of /i, "");
	const result: ImageText = {
		alt: alt ? alt[0].toUpperCase() + alt.slice(1) : "",
		caption: cleanText(f.caption, CAPTION_MAX),
		title: cleanText(f.title, 120),
	};
	if (!result.alt && !result.title) throw new Error("The AI service did not return usable image text. Try again.");
	return result;
}

// ── Wikidata grounding ───────────────────────────────────────────

/** Parse a wbsearchentities response into candidates. */
export function parseSearch(body: unknown): Candidate[] {
	const search = (body as { search?: unknown })?.search;
	if (!Array.isArray(search)) return [];
	const out: Candidate[] = [];
	for (const hit of search) {
		const id = (hit as { id?: unknown })?.id;
		if (typeof id !== "string" || !/^Q\d+$/.test(id)) continue;
		const h = hit as { label?: unknown; description?: unknown; aliases?: unknown; match?: { text?: unknown } };
		const aliases = [...(Array.isArray(h.aliases) ? h.aliases : []), h.match?.text]
			.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
			.map((a) => cleanText(a, 200));
		out.push({
			id,
			label: cleanText(h.label, 200),
			description: cleanText(h.description, 300),
			...(aliases.length ? { aliases: [...new Set(aliases)] } : {}),
		});
	}
	return out;
}

/** The Wikipedia article URL for a sitelink title. */
export function wikipediaUrl(language: string, title: string): string {
	return `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
}

/**
 * One Wikidata Query Service request for what verification needs: each item's
 * P31 (instance of) and P856 (official website) values, deprecated statements
 * excluded, and its `<language>wiki` sitelink title. Only Q-ids get in; items
 * that don't exist (or are redirects) return no rows. The empty last branch
 * keeps an item with none of these in the results.
 */
export function detailsQuery(qids: string[], language: string): string {
	const ids = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))];
	const wiki = /^[a-z]{2,3}$/.test(language) ? `https://${language}.wikipedia.org/` : null;
	return [
		"SELECT ?item ?class ?website ?rank ?title WHERE {",
		`  VALUES ?item { ${ids.map((q) => `wd:${q}`).join(" ")} }`,
		"  ?item wikibase:sitelinks [] .",
		"  { ?item p:P31 ?s . ?s ps:P31 ?class ; wikibase:rank ?r . FILTER(?r != wikibase:DeprecatedRank) }",
		"  UNION { ?item p:P856 ?s . ?s ps:P856 ?website ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) }",
		...(wiki ? [`  UNION { ?article schema:about ?item ; schema:isPartOf <${wiki}> ; schema:name ?title . }`] : []),
		"  UNION {}",
		"}",
	].join("\n");
}

const ENTITY_IRI = "http://www.wikidata.org/entity/";
const entityId = (iri: unknown) => (typeof iri === "string" && iri.startsWith(ENTITY_IRI) && /^Q\d+$/.test(iri.slice(ENTITY_IRI.length)) ? iri.slice(ENTITY_IRI.length) : "");

const PREFERRED_RANK = "http://wikiba.se/ontology#PreferredRank";
/** Sort key for choosing one P856 among several (rows have no order): preferred rank, then https over http, then the smallest URL. */
const websiteKey = (url: string, rank: string) => `${rank === PREFERRED_RANK ? 0 : 1}${/^https:/i.test(url) ? 0 : 1}${url}`;

/**
 * Parse the detailsQuery results (SPARQL JSON): P31 values, one http(s) P856
 * (preferred rank first, then https, then the lexicographically smallest, so
 * the choice doesn't depend on row order), and the Wikipedia sitelink. null
 * when the body isn't a SPARQL result.
 */
export function parseSparqlDetails(body: unknown, language: string): Record<string, WikidataDetails> | null {
	const rows = (body as { results?: { bindings?: unknown } })?.results?.bindings;
	if (!Array.isArray(rows)) return null;
	const out: Record<string, WikidataDetails> = {};
	const websiteKeys = new Map<string, string>();
	for (const row of rows) {
		const value = (key: string) => {
			const v = (row as Record<string, { value?: unknown } | undefined>)?.[key]?.value;
			return typeof v === "string" ? v : "";
		};
		const qid = entityId(value("item"));
		if (!qid) continue;
		const details = (out[qid] ??= { p31: [], wikipedia: "", website: "" });
		const instanceOf = entityId(value("class"));
		if (instanceOf && !details.p31.includes(instanceOf)) details.p31.push(instanceOf);
		const website = value("website");
		if (/^https?:\/\//i.test(website)) {
			const key = websiteKey(website, value("rank"));
			const current = websiteKeys.get(qid);
			if (current === undefined || key < current) {
				websiteKeys.set(qid, key);
				details.website = website;
			}
		}
		const title = value("title");
		if (!details.wikipedia && title) details.wikipedia = wikipediaUrl(language, title);
	}
	return out;
}

/** Whether a candidate's label or one of its aliases is the mention's name (or its surface form), after normalization. */
export function nameMatches(mention: Pick<Mention, "name" | "surface">, candidate: Candidate): boolean {
	const wanted = new Set([normalizeName(mention.name), normalizeName(mention.surface ?? "")].filter(Boolean));
	return [candidate.label, ...(candidate.aliases ?? [])].some((text) => wanted.has(normalizeName(text)));
}

/**
 * Stage 2: keep only candidates whose label or alias matches the mention's
 * name (search hits on a description or a partial word don't count). One
 * match resolves immediately; several go to disambiguation; none drops the
 * mention.
 */
export function attachCandidates(mentions: Mention[], candidates: Candidate[][]): { mentions: GroundedMention[]; ambiguous: number[] } {
	const ambiguous: number[] = [];
	const grounded = mentions.map((m, i) => {
		const list = (candidates[i] ?? []).filter((c) => nameMatches(m, c));
		if (list.length > 1) ambiguous.push(i);
		return { ...m, candidates: list, qid: list.length === 1 ? list[0].id : "" };
	});
	return { mentions: grounded, ambiguous };
}

/** Stage 3: trust a choice only when it is one of the real candidates. */
export function applyChoices(mentions: GroundedMention[], ambiguous: number[], choices: Record<string, string | null>): GroundedMention[] {
	const out = mentions.map((m) => ({ ...m }));
	for (const i of ambiguous) {
		const mention = out[i];
		if (!mention) continue;
		const chosen = choices[mention.name];
		if (!chosen) continue;
		if (mention.candidates.some((c) => c.id === chosen)) mention.qid = chosen;
	}
	return out;
}

/** Whether an item's P31 classes fit the type the article gave the entity. */
export function typeCompatible(type: EntityType, p31: string[]): boolean {
	if (p31.includes(DISAMBIGUATION)) return false;
	const human = p31.includes(HUMAN);
	const creative = p31.some((q) => CREATIVE_WORKS.has(q));
	switch (type) {
		case "Person":
			return human; // An item with no P31 can't be confirmed as a person.
		case "Organization":
			return p31.length > 0 && !human && !creative && !p31.some((q) => GEOGRAPHIC.has(q));
		case "Place":
			return p31.length > 0 && !human && !creative;
		default:
			return !human && !p31.some((q) => q === "Q4167836" || q === "Q11266439" || q === "Q13406463");
	}
}

/**
 * Stage 4: drop unresolved mentions, items Wikidata didn't return, and type
 * mismatches. The entity's name is Wikidata's label (the canonical name),
 * falling back to the model's name.
 */
export function verifyEntities(mentions: GroundedMention[], details: Record<string, WikidataDetails>): Entity[] {
	const out: Entity[] = [];
	const seen = new Set<string>();
	for (const m of mentions) {
		if (!m.qid || seen.has(m.qid)) continue;
		const info = details[m.qid];
		if (!info || !typeCompatible(m.type, info.p31)) continue;
		seen.add(m.qid);
		const label = m.candidates.find((c) => c.id === m.qid)?.label;
		out.push({
			name: label || m.name,
			type: m.type,
			description: m.description,
			qid: m.qid,
			wikipedia: info.wikipedia,
			website: info.website,
			primary: m.primary,
		});
	}
	return out;
}

/** Schema.org nodes for stored entities: { about, mentions }. */
export function entityNodes(entities: Entity[] | undefined | null): { about: Record<string, unknown>[]; mentions: Record<string, unknown>[] } {
	const about: Record<string, unknown>[] = [];
	const mentions: Record<string, unknown>[] = [];
	for (const e of entities ?? []) {
		if (!e?.name || !e.qid || !/^Q\d+$/.test(e.qid)) continue;
		const sameAs = [`https://www.wikidata.org/wiki/${e.qid}`];
		if (e.wikipedia) sameAs.push(e.wikipedia);
		if (e.website) sameAs.push(e.website);
		const node: Record<string, unknown> = {
			"@type": (ENTITY_TYPES as readonly string[]).includes(e.type) ? e.type : "Thing",
			name: e.name,
			sameAs: sameAs.length > 1 ? sameAs : sameAs[0],
		};
		if (e.description) node.description = e.description;
		(e.primary ? about : mentions).push(node);
	}
	return { about, mentions };
}

// ── Content → plain text ─────────────────────────────────────────

/** Plain text from a Portable Text value (or any nested structure holding blocks), paragraphs separated by blank lines. */
export function portableTextToPlain(value: unknown, depth = 0): string {
	if (depth > 8 || value == null) return "";
	if (typeof value === "string") return "";
	if (Array.isArray(value)) {
		return value
			.map((v) => portableTextToPlain(v, depth + 1))
			.filter(Boolean)
			.join("\n\n");
	}
	if (typeof value !== "object") return "";
	const node = value as Record<string, unknown>;
	if (node._type === "block" && Array.isArray(node.children)) {
		return node.children
			.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
			.join("")
			.trim();
	}
	// Custom blocks: look inside nested arrays (columns, callouts…) and plain text props.
	const parts: string[] = [];
	for (const [key, child] of Object.entries(node)) {
		if (key.startsWith("_") || key === "markDefs") continue;
		if (Array.isArray(child) || (child && typeof child === "object")) {
			const text = portableTextToPlain(child, depth + 1);
			if (text) parts.push(text);
		} else if ((key === "text" || key === "caption" || key === "quote") && typeof child === "string" && child.trim()) {
			parts.push(child.trim());
		}
	}
	return parts.join("\n\n");
}

/** A bounded plain-text rendition of an entry: its text-like fields in order. */
export function entryPlainText(data: Record<string, unknown>, fields: Array<{ slug: string; type: string }>, limit = 24000): string {
	const parts: string[] = [];
	for (const field of fields) {
		const value = data[field.slug];
		if (field.type === "portableText" || field.type === "blocks") parts.push(portableTextToPlain(value));
		else if (field.type === "text" && typeof value === "string") parts.push(value.replace(/<[^>]*>/g, " "));
	}
	const text = parts
		.map((p) => p.trim())
		.filter(Boolean)
		.join("\n\n")
		.replace(/[ \t]+/g, " ");
	return [...text].slice(0, limit).join("");
}

// ── Queue ────────────────────────────────────────────────────────

export interface QueueJob {
	kind: "entry" | "media";
	collection?: string;
	entryId?: string;
	mediaId?: string;
	/** Epoch ms when the job may run (debounce / backoff). */
	due: number;
	attempts: number;
	/** Times in a row Wikidata's Retry-After pushed the job back; reset when an attempt fails. */
	deferrals?: number;
	force?: boolean;
	enqueuedAt: number;
	lastError?: string;
	/** Model outputs already paid for, so a retry resumes after them. Valid only for the same text hash. */
	cache?: StageCache;
}

export interface StageCache {
	hash: string;
	mentions?: Mention[];
	choices?: Record<string, string | null>;
	description?: string;
}

export const MAX_ATTEMPTS = 3;
/** Wikidata "slow down" deferrals a job gets before one counts as a failed attempt. */
export const MAX_DEFERRALS = 10;

export function queueId(job: Pick<QueueJob, "kind" | "collection" | "entryId" | "mediaId">): string {
	return job.kind === "media" ? `media:${job.mediaId}` : `entry:${job.collection}:${job.entryId}`;
}

/**
 * Pick the jobs to run this tick: due jobs, at most `perTick`, taking entries
 * and images in turns (so a backlog of one kind can't starve the other), each
 * kind in due order, and never more model calls than the day's remaining
 * allowance (a job costs up to `callsPerJob` calls) or outbound requests than
 * `subrequests` (a job costs up to `subrequestsPerJob`). When a kind's next
 * job doesn't fit, that kind stops (its later jobs don't jump the line).
 */
export function planBatch(
	jobs: Array<{ id: string; data: QueueJob }>,
	opts: {
		now: number;
		perTick: number;
		remainingCalls: number;
		callsPerJob: (job: QueueJob) => number;
		subrequests?: number;
		subrequestsPerJob?: (job: QueueJob) => number;
	},
): Array<{ id: string; data: QueueJob }> {
	const byDue = (a: { id: string; data: QueueJob }, b: { id: string; data: QueueJob }) => a.data.due - b.data.due || a.id.localeCompare(b.id);
	const lanes = (["entry", "media"] as const)
		.map((kind) => jobs.filter((j) => j.data.kind === kind && j.data.due <= opts.now).sort(byDue))
		.filter((lane) => lane.length)
		.sort((a, b) => byDue(a[0], b[0])); // The lane with the oldest job goes first.
	const out: Array<{ id: string; data: QueueJob }> = [];
	let calls = Math.max(0, opts.remainingCalls);
	let requests = opts.subrequests ?? Number.POSITIVE_INFINITY;
	const open = lanes.map(() => true);
	const next = lanes.map(() => 0);
	while (out.length < opts.perTick && open.some(Boolean)) {
		for (let lane = 0; lane < lanes.length && out.length < opts.perTick; lane++) {
			if (!open[lane]) continue;
			const job = lanes[lane][next[lane]];
			if (!job) {
				open[lane] = false;
				continue;
			}
			const cost = opts.callsPerJob(job.data);
			const reqs = opts.subrequestsPerJob?.(job.data) ?? 0;
			if (cost > calls || reqs > requests) {
				open[lane] = false;
				continue;
			}
			calls -= cost;
			requests -= reqs;
			next[lane]++;
			out.push(job);
		}
	}
	return out;
}

/**
 * Push a job back for Wikidata's Retry-After without using up an attempt.
 * null once it has been deferred MAX_DEFERRALS times in a row (a lasting 429),
 * when the caller counts it as a failed attempt instead.
 */
export function deferJob(job: QueueJob, now: number, retryAfterMs: number): QueueJob | null {
	const deferrals = (job.deferrals ?? 0) + 1;
	if (deferrals > MAX_DEFERRALS) return null;
	return { ...job, deferrals, due: now + retryAfterMs };
}

/** Wikimedia User-Agent policy format: client/version (contact) library. The repository is the contact when the site has no URL. */
export function userAgent(version: string, siteUrl: string | undefined): string {
	return `CoywolfPack/${version} (${siteUrl || "https://github.com/coywolf-llc/coywolf-pack"}) EmDash`;
}

/** Retry schedule after a failure: 5, then 20 minutes; null after MAX_ATTEMPTS (3) tries, when the job should be dropped. */
export function retryAt(job: QueueJob, now: number): number | null {
	const attempts = job.attempts + 1;
	if (attempts >= MAX_ATTEMPTS) return null;
	return now + 5 * 60_000 * 4 ** (attempts - 1);
}

/** Merge a re-enqueue into an existing job: push the debounce later, keep attempts reset, keep force if either asked. */
export function mergeJob(existing: QueueJob | null, next: QueueJob): QueueJob {
	if (!existing) return next;
	return { ...next, force: Boolean(existing.force || next.force), enqueuedAt: Math.min(existing.enqueuedAt, next.enqueuedAt), attempts: 0 };
}

/** UTC day key for the daily call counter. */
export function dayKey(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

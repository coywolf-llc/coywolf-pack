/**
 * Pure builders for the Schema & Social module: the JSON-LD @graph, the
 * BreadcrumbList, the robots directives, and og:locale. No I/O here (the
 * module resolves settings, bylines and media first), so everything is unit
 * testable with `node --test src/schema/graph.test.mjs`.
 *
 * Only type imports: this file must run under Node's type stripping.
 */
import type { BreadcrumbItem, PublicPageContext } from "emdash";

// ── Stored shapes ────────────────────────────────────────────────

/** One property row from a property picker: a text/URL value, or sub-fields for structured properties. */
export interface PropertyRow {
	prop: string;
	value: string | Record<string, string>;
	/** Person rows only: output only when the person is a page's main subject (their profile page), not on every article. */
	profileOnly?: boolean;
}

/** Site Details: who publishes the site. */
export interface SiteDetails {
	publisherType: "organization" | "person";
	/** Byline whose Person properties describe the publisher, when publisherType is "person". */
	personBylineId?: string | null;
	/** Organization property rows, in order. */
	orgRows: PropertyRow[];
	/** Organization type (Organization or a subtype such as NewsMediaOrganization). */
	organizationType?: string | null;
}

/** Page and Article types for a collection (or "_home" / "_custom" for non-content pages). */
export interface TypeChoice {
	pageType?: string;
	/** Article subtype, or "none" for no Article node. */
	articleType?: string;
}
export type TypeMap = Record<string, TypeChoice>;

/**
 * What a single entry is about (its WebPage's mainEntity): "byline:<id>" for
 * a person, or "publisher" for the site publisher. Missing means none.
 */
export type MainSubject = `byline:${string}` | "publisher";

/** The byline id in a "byline:<id>" main subject, or null. */
export function mainSubjectByline(subject: string | null | undefined): string | null {
	return typeof subject === "string" && subject.startsWith("byline:") && subject.length > 7 ? subject.slice(7) : null;
}

export const HOME_KEY = "_home";
export const CUSTOM_KEY = "_custom";
export const NO_ARTICLE = "none";

/** Image facts the module looked up (media dimensions and alt). */
export interface ImageInfo {
	url: string;
	width?: number | null;
	height?: number | null;
	alt?: string | null;
	mimeType?: string | null;
}

export type Node = Record<string, unknown>;

// ── URL helpers ──────────────────────────────────────────────────

const ABSOLUTE = /^https?:\/\//i;

/** Origin without a trailing slash, e.g. "https://example.com". */
export function originOf(siteUrl: string): string {
	try {
		return new URL(siteUrl).origin;
	} catch {
		return siteUrl.replace(/\/+$/, "");
	}
}

/** Join a root-relative path to the origin; absolute URLs pass through; anything else is dropped. */
export function absolute(url: string | null | undefined, origin: string): string | undefined {
	if (!url) return undefined;
	const value = url.trim();
	if (!value || /\s/.test(value)) return undefined;
	if (ABSOLUTE.test(value)) return value;
	if (value.startsWith("//")) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return /^(mailto|tel):/i.test(value) ? value : undefined;
	return `${origin}${value.startsWith("/") ? "" : "/"}${value}`;
}

/** The page's own URL for @id anchors: canonical, else the request URL without query or hash. */
export function pageUrl(page: Pick<PublicPageContext, "canonical" | "url">): string {
	if (page.canonical) return page.canonical;
	try {
		const u = new URL(page.url);
		return `${u.origin}${u.pathname}`;
	} catch {
		return page.url;
	}
}

/** A same-site EmDash media URL, as the column and value to look it up by. */
export interface MediaRef {
	by: "storage_key" | "id";
	value: string;
}

/**
 * EmDash serves media at /_emdash/api/media/file/<storage key> and
 * /_emdash/api/media/asset/<id>/<filename>. Returns how to look up a
 * same-site media URL (relative, or absolute on `origin`), or null. URLs with
 * a query string are skipped: a resized variant's dimensions differ from the
 * stored ones.
 */
export function mediaRefFromUrl(url: string | null | undefined, origin?: string): MediaRef | null {
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url, origin || "https://site.invalid");
	} catch {
		return null;
	}
	if (ABSOLUTE.test(url) && origin && parsed.origin !== originOf(origin)) return null;
	if (parsed.search) return null;
	const decode = (s: string) => {
		try {
			return decodeURIComponent(s);
		} catch {
			return null;
		}
	};
	const file = /^\/_emdash\/api\/media\/file\/([^/]+)$/.exec(parsed.pathname);
	if (file) {
		const value = decode(file[1]);
		return value ? { by: "storage_key", value } : null;
	}
	const asset = /^\/_emdash\/api\/media\/asset\/([^/]+)\/[^/]+$/.exec(parsed.pathname);
	if (asset) {
		const value = decode(asset[1]);
		return value ? { by: "id", value } : null;
	}
	return null;
}

// ── Property rows → schema properties ────────────────────────────

/** Properties whose value is another typed object, keyed to the type that wraps a text value (as its name). */
const OBJECT_PROPS: Record<string, string> = {
	founder: "Person",
	parentOrganization: "Organization",
	subOrganization: "Organization",
	memberOf: "Organization",
	member: "Person",
	sponsor: "Organization",
	funder: "Organization",
	brand: "Brand",
	birthPlace: "Place",
	homeLocation: "Place",
	workLocation: "Place",
	nationality: "Country",
	worksFor: "Organization",
	affiliation: "Organization",
	alumniOf: "Organization",
	colleague: "Person",
};

const URL_PROPS = new Set(["@id", "url", "sameAs", "logo", "image", "ethicsPolicy", "publishingPrinciples", "masthead", "missionCoveragePrioritiesPolicy", "diversityPolicy", "diversityStaffingReport", "correctionsPolicy", "verificationFactCheckingPolicy", "unnamedSourcesPolicy", "actionableFeedbackPolicy", "ownershipFundingInfo", "noBylinesPolicy"]);
const NUMBER_PROPS = new Set(["numberOfEmployees"]);

/**
 * Shape ordered prop/value rows into schema properties, as Coywolf SEO does
 * on WordPress: a property repeated across rows becomes an array; logo (and
 * an Organization's image) becomes an ImageObject; entity references are
 * wrapped in their type; address/contactPoint get PostalAddress/ContactPoint.
 * Relative URLs are made absolute against `origin`.
 */
export function shapeRows(rows: PropertyRow[] | null | undefined, parentType: "Organization" | "Person", origin: string): Node {
	const out: Node = {};
	for (const row of rows ?? []) {
		if (!row || typeof row.prop !== "string" || !row.prop) continue;
		const prop = row.prop;
		let shaped: unknown;
		if (row.value && typeof row.value === "object") {
			const fields: Record<string, string> = {};
			for (const [key, raw] of Object.entries(row.value)) {
				const value = typeof raw === "string" ? raw.trim() : "";
				if (!value) continue;
				fields[key] = key === "url" || key === "@id" ? (absolute(value, origin) ?? "") : key === "addressCountry" ? countryCode(value) : value;
				if (!fields[key]) delete fields[key];
			}
			if (!Object.keys(fields).length) continue;
			const type = prop === "address" ? "PostalAddress" : prop === "contactPoint" ? "ContactPoint" : OBJECT_PROPS[prop];
			if (!type) continue; // Unknown structured value: never output raw objects.
			shaped = { "@type": type, ...fields };
		} else {
			const text = typeof row.value === "string" ? row.value.trim() : "";
			if (!text) continue;
			const value = URL_PROPS.has(prop) ? absolute(text, origin) : text;
			if (!value) continue;
			if (prop === "logo" || (prop === "image" && parentType === "Organization")) {
				shaped = { "@type": "ImageObject", url: value };
			} else if (OBJECT_PROPS[prop]) {
				shaped = { "@type": OBJECT_PROPS[prop], name: value };
			} else if (NUMBER_PROPS.has(prop) && /^\d+$/.test(value)) {
				shaped = { "@type": "QuantitativeValue", value: Number(value) };
			} else {
				shaped = value;
			}
		}
		if (!(prop in out)) out[prop] = shaped;
		else if (prop === "@id") continue; // Single-valued; the first row wins.
		else {
			const current = out[prop];
			out[prop] = Array.isArray(current) ? [...current, shaped] : [current, shaped];
		}
	}
	return out;
}

/** Common country names and three-letter codes people type, as the two-letter ISO 3166-1 codes Google expects. */
const COUNTRY_ALIASES: Record<string, string> = {
	usa: "US", "united states": "US", "united states of america": "US", us: "US", "u.s.": "US", "u.s.a.": "US", america: "US",
	uk: "GB", "united kingdom": "GB", "great britain": "GB", gbr: "GB", england: "GB", scotland: "GB", wales: "GB",
	can: "CA", canada: "CA", aus: "AU", australia: "AU", nzl: "NZ", "new zealand": "NZ", irl: "IE", ireland: "IE",
	deu: "DE", germany: "DE", fra: "FR", france: "FR", esp: "ES", spain: "ES", ita: "IT", italy: "IT", nld: "NL", netherlands: "NL",
	mex: "MX", mexico: "MX", bra: "BR", brazil: "BR", ind: "IN", india: "IN", jpn: "JP", japan: "JP",
};

/** A PostalAddress country as a two-letter code: aliases are mapped, two-letter codes uppercased, anything else kept as typed. */
export function countryCode(value: string): string {
	const alias = COUNTRY_ALIASES[value.toLowerCase()];
	if (alias) return alias;
	return /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : value;
}

/** The @id row's value, if any. */
export function idFromRows(rows: PropertyRow[] | null | undefined, origin: string): string | undefined {
	const row = (rows ?? []).find((r) => r?.prop === "@id" && typeof r.value === "string" && r.value.trim());
	return row ? absolute(row.value as string, origin) : undefined;
}

// ── People and publisher ─────────────────────────────────────────

/** What EmDash knows about a byline, used when its stored rows don't say. */
export interface BylineFacts {
	id: string;
	slug: string;
	displayName: string;
	bio?: string | null;
	websiteUrl?: string | null;
	avatarUrl?: string | null;
}

/**
 * A Person node from a byline: stored property rows first, then the byline's
 * own name, website (or author page), bio and avatar. `defaultId` anchors it
 * unless the rows set an @id. Rows marked profile-only are left out unless
 * `profile` is set (the person is the page's main subject).
 */
export function personNode(opts: {
	byline?: BylineFacts | null;
	rows?: PropertyRow[] | null;
	origin: string;
	defaultId: string;
	authorUrl?: string | null;
	profile?: boolean;
}): Node | null {
	const rows = opts.profile ? opts.rows : opts.rows?.filter((r) => !r?.profileOnly);
	const shaped = shapeRows(rows, "Person", opts.origin);
	const node: Node = { "@type": "Person", ...shaped };
	node["@id"] = (shaped["@id"] as string | undefined) ?? opts.defaultId;
	const b = opts.byline;
	if (!node.name) {
		if (!b?.displayName) return null;
		node.name = b.displayName;
	}
	if (!node.url) {
		const url = absolute(b?.websiteUrl, opts.origin) ?? absolute(opts.authorUrl, opts.origin);
		if (url) node.url = url;
	}
	if (!node.description && b?.bio?.trim()) node.description = b.bio.trim();
	if (!node.image) {
		const avatar = absolute(b?.avatarUrl, opts.origin);
		if (avatar) node.image = avatar;
	}
	return node;
}

/** Author page URL from a pattern like "/author/{slug}/", or null when no pattern is set. */
export function authorPath(pattern: string | null | undefined, slug: string): string | null {
	if (!pattern?.trim() || !slug) return null;
	return pattern.trim().replaceAll("{slug}", encodeURIComponent(slug));
}

/**
 * The @id for an author byline. The byline chosen as the publisher Person
 * shares the publisher's @id, so the graph has one Person for them. Others
 * anchor on their author page (when the site has an author URL pattern) or
 * the site root.
 */
export function authorId(opts: {
	bylineId: string;
	slug: string;
	origin: string;
	authorUrl?: string | null;
	details?: SiteDetails | null;
	personRows?: PropertyRow[] | null;
}): string {
	if (opts.details?.publisherType === "person" && opts.details.personBylineId && opts.details.personBylineId === opts.bylineId)
		return publisherId(opts.details, opts.origin, opts.personRows);
	return opts.authorUrl ? `${opts.authorUrl}#person` : `${opts.origin}/#person-${encodeURIComponent(opts.slug)}`;
}

/** A robots max-snippet / max-video-preview setting: blank, missing or invalid means -1 (no limit). */
export function parseLimit(value: unknown): number {
	if (value === null || value === undefined) return -1;
	if (typeof value === "string" && !value.trim()) return -1;
	const n = Number(value);
	if (!Number.isFinite(n)) return -1;
	return Math.max(-1, Math.trunc(n));
}

export function publisherId(details: SiteDetails | null | undefined, origin: string, personRows?: PropertyRow[] | null): string {
	if (details?.publisherType === "person") return idFromRows(personRows, origin) ?? `${origin}/#person`;
	return idFromRows(details?.orgRows, origin) ?? `${origin}/#organization`;
}

/**
 * The publisher node (Organization or Person) from Site Details. Falls back
 * to the site name, URL and logo so the graph's publisher references always
 * resolve, as EmDash's own JSON-LD names the site as publisher.
 */
export function publisherNode(opts: {
	details: SiteDetails | null | undefined;
	origin: string;
	siteName: string;
	siteLogo?: ImageInfo | null;
	person?: { byline: BylineFacts | null; rows: PropertyRow[] | null } | null;
	authorUrl?: string | null;
}): Node {
	const { details, origin } = opts;
	const id = publisherId(details, origin, opts.person?.rows);
	if (details?.publisherType === "person") {
		const node = personNode({
			byline: opts.person?.byline,
			rows: opts.person?.rows,
			origin,
			defaultId: id,
			authorUrl: opts.authorUrl,
		});
		if (node) return { ...node, "@id": id };
		return { "@type": "Organization", "@id": id, name: opts.siteName, url: `${origin}/` };
	}
	const shaped = shapeRows(details?.orgRows, "Organization", origin);
	const node: Node = { "@type": details?.organizationType || "Organization", ...shaped, "@id": id };
	if (!node.name) node.name = opts.siteName;
	if (!node.url) node.url = `${origin}/`;
	if (!node.logo && opts.siteLogo?.url) node.logo = imageObject(opts.siteLogo, origin);
	return node;
}

export function imageObject(image: ImageInfo, origin: string, id?: string): Node {
	const url = absolute(image.url, origin) ?? image.url;
	const node: Node = { "@type": "ImageObject" };
	if (id) node["@id"] = id;
	node.url = url;
	node.contentUrl = url;
	if (image.width && image.width > 0) node.width = image.width;
	if (image.height && image.height > 0) node.height = image.height;
	if (image.alt?.trim()) node.caption = image.alt.trim();
	return node;
}

/** Fill in width/height/caption on ImageObject values (logo, image) once they've been looked up. */
export function enrichImageObjects(node: Node, lookup: (url: string) => ImageInfo | null | undefined): Node {
	for (const key of ["logo", "image"]) {
		const value = node[key];
		const list = Array.isArray(value) ? value : [value];
		for (const item of list) {
			if (!item || typeof item !== "object" || (item as Node)["@type"] !== "ImageObject") continue;
			const obj = item as Node;
			const info = typeof obj.url === "string" ? lookup(obj.url) : null;
			if (!info) continue;
			if (info.width && obj.width === undefined) obj.width = info.width;
			if (info.height && obj.height === undefined) obj.height = info.height;
			if (info.alt?.trim() && obj.caption === undefined) obj.caption = info.alt.trim();
		}
	}
	return node;
}

// ── Breadcrumbs ──────────────────────────────────────────────────

function safeDecodePath(path: string): string {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

function humanize(segment: string): string {
	let text = segment;
	try {
		text = decodeURIComponent(segment);
	} catch {
		// Keep the raw segment.
	}
	text = text.replace(/[-_]+/g, " ").trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : segment;
}

/**
 * The breadcrumb trail for a page. `page.breadcrumbs` is used verbatim when
 * the theme provides it (`[]` means no breadcrumbs); otherwise it's derived
 * from the path: Home, each parent segment (its page's title from `titles`,
 * keyed by decoded path without a trailing slash, else humanized), then the
 * page title.
 */
export function breadcrumbTrail(page: PublicPageContext, origin: string, homeLabel = "Home", titles?: ReadonlyMap<string, string> | null): BreadcrumbItem[] {
	if (page.breadcrumbs !== undefined) return page.breadcrumbs;
	const segments = (page.path || "/").split("/").filter(Boolean);
	if (!segments.length) return [];
	const trailing = (page.path || "").endsWith("/");
	const trail: BreadcrumbItem[] = [{ name: homeLabel, url: `${origin}/` }];
	segments.forEach((segment, i) => {
		const last = i === segments.length - 1;
		const path = `/${segments.slice(0, i + 1).join("/")}${trailing || !last ? "/" : ""}`;
		const known = last ? null : titles?.get(safeDecodePath(`/${segments.slice(0, i + 1).join("/")}`));
		const name = last ? page.pageTitle || page.seo?.ogTitle || humanize(segment) : known || humanize(segment);
		trail.push({ name, url: last ? pageUrl(page) : `${origin}${path}` });
	});
	return trail;
}

/** A BreadcrumbList node, or null for an empty trail (or a derived one-item trail). */
export function breadcrumbNode(trail: BreadcrumbItem[], id: string, origin: string, explicit: boolean): Node | null {
	const items = trail.filter((c) => c && typeof c.name === "string" && c.name.trim());
	if (items.length < (explicit ? 1 : 2)) return null;
	return {
		"@type": "BreadcrumbList",
		"@id": id,
		itemListElement: items.map((crumb, i) => {
			const element: Node = { "@type": "ListItem", position: i + 1, name: crumb.name.trim() };
			const url = absolute(crumb.url, origin);
			if (url) element.item = url;
			return element;
		}),
	};
}

// ── The graph ────────────────────────────────────────────────────

export interface GraphInput {
	page: PublicPageContext;
	origin: string;
	siteName: string;
	tagline?: string | null;
	/** BCP 47 language of the page, e.g. "en-US". */
	language?: string | null;
	/** Collection/page defaults. */
	types: TypeMap;
	/** Per-entry override for this page, if any. */
	override?: TypeChoice | null;
	/** Search URL template (e.g. "/?s={search_term_string}"); empty for no SearchAction. */
	searchUrl?: string | null;
	publisher: Node;
	/** Author Person nodes for the entry, in credit order. */
	authors: Node[];
	/**
	 * What the page is about (its WebPage's mainEntity): a Person built with its
	 * profile-only properties, or the publisher node. Null for none.
	 */
	mainEntity?: Node | null;
	/** The page's primary image (og:image), looked up for dimensions and alt. */
	image?: ImageInfo | null;
	/** Include a BreadcrumbList (the schema.breadcrumbs feature). */
	breadcrumbs: boolean;
	homeLabel?: string;
	/** Titles of the pages on the path, for a derived trail (Child Pages: pageTitlesByPath). */
	breadcrumbTitles?: ReadonlyMap<string, string> | null;
}

export function isHome(page: PublicPageContext): boolean {
	return !page.content && (page.path === "/" || page.path === "");
}

/** The WebPage subtype and Article subtype (or "none") for a page. */
export function resolveTypes(page: PublicPageContext, types: TypeMap, override?: TypeChoice | null): { pageType: string; articleType: string } {
	const key = page.content ? page.content.collection : isHome(page) ? HOME_KEY : CUSTOM_KEY;
	const defaults = types[key] ?? {};
	const pageType = override?.pageType || defaults.pageType || "WebPage";
	// EmDash's own JSON-LD is a BlogPosting for article pages; keep that unless told otherwise.
	const articleType = override?.articleType || defaults.articleType || (page.pageType === "article" ? "BlogPosting" : NO_ARTICLE);
	return { pageType, articleType };
}

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/**
 * Build the @graph for a page: WebSite, publisher, WebPage (typed), the
 * primary ImageObject, author Person(s), the Article (typed) and, when
 * enabled, the BreadcrumbList. Keeps everything EmDash's own JSON-LD gives
 * (headline, description, image, dates, author, publisher).
 */
export function buildGraph(input: GraphInput): Node {
	const { page, origin } = input;
	const url = pageUrl(page);
	const websiteId = `${origin}/#website`;
	const webpageId = `${url}#webpage`;
	const publisherRef = { "@id": String(input.publisher["@id"]) };
	const title = page.seo?.ogTitle ?? page.pageTitle ?? page.title ?? input.siteName;
	const description = page.seo?.ogDescription || page.description || undefined;
	const language = input.language || undefined;
	const published = page.articleMeta?.publishedTime || undefined;
	const modified = page.articleMeta?.modifiedTime || published;
	const { pageType, articleType } = resolveTypes(page, input.types, input.override);
	const home = isHome(page);
	const publisher: Node = { ...input.publisher };

	const website: Node = {
		"@type": "WebSite",
		"@id": websiteId,
		url: `${origin}/`,
		name: input.siteName,
		...(input.tagline ? { description: input.tagline } : {}),
		publisher: publisherRef,
		...(language ? { inLanguage: language } : {}),
	};
	const searchTarget = input.searchUrl?.includes("{search_term_string}") ? absolute(input.searchUrl, origin) : undefined;
	if (searchTarget) {
		website.potentialAction = {
			"@type": "SearchAction",
			target: { "@type": "EntryPoint", urlTemplate: searchTarget },
			"query-input": "required name=search_term_string",
		};
	}

	const webpage: Node = {
		"@type": pageType,
		"@id": webpageId,
		url,
		name: title,
		isPartOf: { "@id": websiteId },
		...(description ? { description } : {}),
		...(language ? { inLanguage: language } : {}),
		...(published ? { datePublished: published } : {}),
		...(modified ? { dateModified: modified } : {}),
	};
	if (home) webpage.about = publisherRef;
	// Profile pages: Google reads dateCreated / dateModified on the ProfilePage.
	if (pageType === "ProfilePage" && published) webpage.dateCreated = published;

	const nodes: Node[] = [webpage];

	// The page's main subject: one node in the graph, referenced from the WebPage.
	const mainId = typeof input.mainEntity?.["@id"] === "string" ? (input.mainEntity["@id"] as string) : null;
	if (input.mainEntity && mainId) {
		webpage.mainEntity = { "@id": mainId };
		if (mainId === publisherRef["@id"]) absorb(publisher, input.mainEntity);
		else nodes.push({ ...input.mainEntity });
	}

	let imageRef: Node | undefined;
	if (input.image?.url) {
		const image = imageObject(input.image, origin, `${url}#primaryimage`);
		nodes.push(image);
		imageRef = { "@id": image["@id"] };
		webpage.primaryImageOfPage = imageRef;
		webpage.image = imageRef;
	}

	if (input.breadcrumbs) {
		const explicit = page.breadcrumbs !== undefined;
		const crumbs = breadcrumbNode(breadcrumbTrail(page, origin, input.homeLabel, input.breadcrumbTitles), `${url}#breadcrumb`, origin, explicit);
		if (crumbs) {
			webpage.breadcrumb = { "@id": crumbs["@id"] };
			nodes.push(crumbs);
		}
	}

	if (articleType !== NO_ARTICLE) {
		const article: Node = {
			"@type": articleType,
			"@id": `${url}#article`,
			url,
			headline: truncate(String(title), 110),
			...(description ? { description } : {}),
			...(imageRef ? { image: imageRef } : {}),
			...(published ? { datePublished: published } : {}),
			...(modified ? { dateModified: modified } : {}),
			isPartOf: { "@id": webpageId },
			mainEntityOfPage: { "@id": webpageId },
			publisher: publisherRef,
			...(language ? { inLanguage: language } : {}),
		};
		const authors = input.authors.filter((a) => a && a["@id"]);
		const publisherIsAuthor = (a: Node) => a["@id"] === publisherRef["@id"];
		if (authors.length) {
			const refs = authors.map((a) => ({ "@id": String(a["@id"]) }));
			article.author = refs.length === 1 ? refs[0] : refs;
			for (const a of authors) {
				// The main subject already has a (fuller) node with this @id.
				if (a["@id"] === mainId && !publisherIsAuthor(a)) absorb(nodes.find((n) => n["@id"] === mainId) ?? a, a);
				else if (!publisherIsAuthor(a)) nodes.push(a);
				// The publisher person also wrote this: one Person node, with the author's extra properties.
				else absorb(publisher, a);
			}
		} else if (page.articleMeta?.author) {
			article.author = { "@type": "Person", name: page.articleMeta.author };
		}
		nodes.push(article);
		// The Article carries the description and dates; the WebPage doesn't repeat them.
		delete webpage.description;
		delete webpage.datePublished;
		delete webpage.dateModified;
		delete webpage.dateCreated;
	}

	nodes.push(website, publisher);
	return { "@context": "https://schema.org", "@graph": linkNestedEntities(dedupeById(nodes)) };
}

/** Copy properties `extra` has and `target` lacks (two views of the same entity). */
function absorb(target: Node, extra: Node): void {
	for (const [k, v] of Object.entries(extra)) if (target[k] === undefined) target[k] = v;
}

/**
 * Replace nested copies of entities that already have their own node with a
 * reference: same `@id`, or (for people and organizations) same `url`. E.g.
 * the publisher's founder who is also the article's author becomes
 * `{ "@id": <author> }` instead of a second Person.
 */
export function linkNestedEntities(nodes: Node[]): Node[] {
	const byId = new Map<string, Node>();
	const byUrl = new Map<string, string>();
	const kind = (t: unknown) => (typeof t === "string" && /Person$/.test(t) ? "person" : typeof t === "string" && /Organization$|Corporation|Business|NGO|Group$/.test(t) ? "org" : null);
	for (const n of nodes) {
		const id = n["@id"];
		if (typeof id !== "string") continue;
		byId.set(id, n);
		const k = kind(n["@type"]);
		if (k && typeof n.url === "string") byUrl.set(`${k} ${n.url}`, id);
	}
	const visit = (value: unknown, top: boolean): unknown => {
		if (Array.isArray(value)) return value.map((v) => visit(v, false));
		if (!value || typeof value !== "object") return value;
		const obj = value as Node;
		if (!top) {
			const id = typeof obj["@id"] === "string" ? obj["@id"] : null;
			if (id && byId.has(id) && Object.keys(obj).length > 1) return { "@id": id };
			const k = kind(obj["@type"]);
			const match = k && typeof obj.url === "string" ? byUrl.get(`${k} ${obj.url}`) : undefined;
			if (match) return { "@id": match };
		}
		const out: Node = {};
		for (const [key, v] of Object.entries(obj)) out[key] = visit(v, false);
		return out;
	};
	return nodes.map((n) => visit(n, true) as Node);
}

function dedupeById(nodes: Node[]): Node[] {
	const seen = new Set<string>();
	return nodes.filter((n) => {
		const id = n["@id"];
		if (typeof id !== "string") return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

/** A standalone BreadcrumbList document, for when breadcrumbs are on but the graph is off. */
export function breadcrumbDocument(page: PublicPageContext, origin: string, homeLabel?: string, titles?: ReadonlyMap<string, string> | null): Node | null {
	const node = breadcrumbNode(breadcrumbTrail(page, origin, homeLabel, titles), `${pageUrl(page)}#breadcrumb`, origin, page.breadcrumbs !== undefined);
	return node ? { "@context": "https://schema.org", ...node } : null;
}

// ── Robots ───────────────────────────────────────────────────────

export interface RobotsSettings {
	/** "large" (default), "standard", "none", or "" to omit. */
	maxImagePreview?: string | null;
	/** Characters; -1 = no limit (default). null/undefined omits. */
	maxSnippet?: number | null;
	/** Seconds; -1 = no limit (default). null/undefined omits. */
	maxVideoPreview?: number | null;
	/** Add nofollow site-wide. */
	nofollow?: boolean;
}

/**
 * Merge the page's robots value (EmDash sets "noindex, nofollow" for entries
 * marked No index) with the site-wide directives:
 * "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1".
 */
export function robotsContent(pageRobots: string | null | undefined, settings: RobotsSettings): string {
	const tokens = (pageRobots ?? "")
		.split(",")
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	const has = (t: string) => tokens.includes(t);
	const keyed = (k: string) => tokens.some((t) => t.startsWith(`${k}:`));
	const noindex = has("noindex") || has("none");
	const nofollow = has("nofollow") || has("none") || !!settings.nofollow;
	const out = [noindex ? "noindex" : "index", nofollow ? "nofollow" : "follow"];
	for (const t of tokens) if (!["index", "noindex", "follow", "nofollow", "all", "none"].includes(t)) out.push(t);
	if (!noindex) {
		const image = settings.maxImagePreview ?? "large";
		if (image && ["none", "standard", "large"].includes(image) && !keyed("max-image-preview")) out.push(`max-image-preview:${image}`);
		if (typeof settings.maxSnippet === "number" && Number.isFinite(settings.maxSnippet) && !keyed("max-snippet"))
			out.push(`max-snippet:${Math.max(-1, Math.trunc(settings.maxSnippet))}`);
		if (typeof settings.maxVideoPreview === "number" && Number.isFinite(settings.maxVideoPreview) && !keyed("max-video-preview"))
			out.push(`max-video-preview:${Math.max(-1, Math.trunc(settings.maxVideoPreview))}`);
	}
	return out.join(", ");
}

// ── og:locale ────────────────────────────────────────────────────

/** Default territory for languages whose usual one isn't the language code uppercased. */
const DEFAULT_REGION: Record<string, string> = {
	en: "US", ja: "JP", zh: "CN", ko: "KR", sv: "SE", da: "DK", nb: "NO", nn: "NO", el: "GR", cs: "CZ",
	uk: "UA", he: "IL", ar: "AR", hi: "IN", vi: "VN", et: "EE", sl: "SI", sr: "RS", ca: "ES", ga: "IE",
	fa: "IR", ms: "MY", bn: "IN", ur: "PK", sq: "AL", ka: "GE", hy: "AM", kk: "KZ", eu: "ES", gl: "ES",
	cy: "GB", fil: "PH", tl: "PH", sw: "KE", ta: "IN", te: "IN", af: "ZA", zu: "ZA",
};

/** Open Graph locale ("en_US") from a BCP 47 tag ("en", "en-US", "pt-br"). */
export function ogLocale(locale: string | null | undefined): string | null {
	if (!locale) return null;
	const parts = locale.trim().replace(/_/g, "-").split("-").filter(Boolean);
	const lang = parts[0]?.toLowerCase();
	if (!lang || !/^[a-z]{2,3}$/.test(lang)) return null;
	const region = parts.slice(1).find((p) => /^[a-z]{2}$/i.test(p))?.toUpperCase() ?? DEFAULT_REGION[lang] ?? lang.toUpperCase();
	return `${lang}_${region}`;
}

// ── Videos ───────────────────────────────────────────────────────

/** A video a theme passes in the page context (`page.coywolf.videos`). */
export interface ThemeVideo {
	name?: string;
	description?: string;
	thumbnailUrl?: string | string[];
	embedUrl?: string;
	contentUrl?: string;
	uploadDate?: string;
	duration?: string;
}

const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

/** Clean a theme-provided video into a VideoObject node, or null if it has nothing usable. */
export function themeVideoNode(input: unknown, origin: string): Node | null {
	if (!input || typeof input !== "object") return null;
	const v = input as Record<string, unknown>;
	const text = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
	const url = (x: unknown) => (typeof x === "string" ? absolute(x.trim(), origin) : undefined);
	const embedUrl = url(v.embedUrl);
	const contentUrl = url(v.contentUrl);
	if (!embedUrl && !contentUrl) return null;
	const thumbs = (Array.isArray(v.thumbnailUrl) ? v.thumbnailUrl : [v.thumbnailUrl]).map(url).filter((t): t is string => !!t);
	const node: Node = { "@type": "VideoObject" };
	const name = text(v.name, 200);
	if (name) node.name = name;
	const description = text(v.description, 1000) || name;
	if (description) node.description = description;
	if (thumbs.length) node.thumbnailUrl = thumbs;
	if (typeof v.uploadDate === "string" && !Number.isNaN(Date.parse(v.uploadDate))) node.uploadDate = v.uploadDate;
	if (typeof v.duration === "string" && ISO_DURATION.test(v.duration)) node.duration = v.duration;
	if (embedUrl) node.embedUrl = embedUrl;
	if (contentUrl) node.contentUrl = contentUrl;
	return node;
}

/**
 * Add VideoObject nodes to a graph and link them from the Article (or the
 * WebPage when there's no Article). Duplicates (same embed or content URL)
 * are dropped; each video gets an @id under the page URL.
 */
export function attachVideos(graph: { "@graph": Node[] }, videos: Node[]): void {
	if (!videos.length) return;
	const nodes = graph["@graph"];
	const article = nodes.find((n) => typeof n["@id"] === "string" && (n["@id"] as string).endsWith("#article"));
	const webpage = nodes.find((n) => typeof n["@id"] === "string" && (n["@id"] as string).endsWith("#webpage"));
	const owner = article ?? webpage;
	if (!owner) return;
	const base = String(owner["@id"]).replace(/#[^#]*$/, "");
	const seen = new Set<string>();
	const refs: Node[] = [];
	for (const video of videos) {
		const key = String(video.embedUrl ?? video.contentUrl ?? "");
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const uid = /([0-9a-f]{32})/.exec(key)?.[1];
		const id = `${base}#video-${uid ?? refs.length + 1}`;
		const { "@context": _omit, ...rest } = video;
		nodes.splice(nodes.indexOf(owner) + 1 + refs.length, 0, { ...rest, "@id": id });
		refs.push({ "@id": id });
	}
	if (refs.length) owner.video = refs.length === 1 ? refs[0] : refs;
}

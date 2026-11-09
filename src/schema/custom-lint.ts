/**
 * Rich-result lint for Schema & Social's custom markup: Google's required
 * and recommended properties for the types it validates most, value checks
 * (prices, currencies, ratings, dates, URLs, enumerations), empty values,
 * nested objects without a type, and schema.org names typed with the wrong
 * case (`pricecurrency` for `priceCurrency`). Warnings never block a save.
 *
 * Table-driven: a type's rules go in TYPE_RULES (its subtypes in SUBTYPES),
 * a property's value check in VALUE_CHECKS, an enumeration in ENUMS.
 *
 * Pure, no imports: shared by the save routes, the Preview and the admin
 * editor (which shows the same warnings live).
 */

export interface LintWarning {
	/** Where: the node's type, then the property path (`WebApplication.offers.priceSpecification[1]`). */
	at: string;
	message: string;
	/** Informational (true), not a problem to fix. */
	note?: boolean;
}

export interface LintOptions {
	/** The pack's Schema.org graph is on: the page already has WebSite and WebPage nodes. */
	graph?: boolean;
}

type Obj = Record<string, unknown>;
type Warn = (at: string, message: string, note?: boolean) => void;

/** One of these properties (a list: any one of them). */
type Spec = string | string[];

interface TypeRule {
	/** What Google calls the result, for the required-property messages. */
	google?: string;
	required?: Spec[];
	recommended?: Spec[];
	/** Checks that look at more than one property. */
	check?: (node: Obj, at: string, warn: Warn) => void;
	/** Shown once per node of this type. */
	note?: string;
}

// ── Values ───────────────────────────────────────────────────────

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Absent, null, "", [], {} (or an object with only @type), or a list of only those. */
export function isEmpty(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return !value.trim();
	if (Array.isArray(value)) return value.every(isEmpty);
	if (isObj(value)) return Object.keys(value).every((k) => k === "@type" || k === "@context");
	return false;
}

const present = (node: Obj, prop: string) => !isEmpty(node[prop]);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
const typesOf = (node: Obj): string[] => list(node["@type"]).filter((t): t is string => typeof t === "string" && Boolean(t.trim()));
const code = (s: string) => `\`${s}\``;

/** A number, or a string that is only a number ("9.99", "0"): no currency symbol, no thousands separator. */
export function numeric(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
	return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** A full URL, a path on the site, or a #name (both resolved against the page). */
const URLISH = /^(https?:\/\/|\/|#|\.\.?\/)/i;

/** Active ISO 4217 currency codes. */
const CURRENCIES = new Set(
	(
		"AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY " +
		"COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK " +
		"JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD " +
		"NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL " +
		"THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XCD XCG XDR XOF XPD XPF XPT XSU XUA " +
		"YER ZAR ZMW ZWG ZWL"
	).split(" "),
);

/** Values Google accepts for an enumeration (with or without https://schema.org/ in front). */
const ENUMS: Record<string, string[]> = {
	availability: ["BackOrder", "Discontinued", "InStock", "InStoreOnly", "LimitedAvailability", "MadeToOrder", "OnlineOnly", "OutOfStock", "PreOrder", "PreSale", "Reserved", "SoldOut"],
	itemCondition: ["NewCondition", "RefurbishedCondition", "UsedCondition", "DamagedCondition"],
	eventStatus: ["EventScheduled", "EventCancelled", "EventMovedOnline", "EventPostponed", "EventRescheduled"],
	eventAttendanceMode: ["OfflineEventAttendanceMode", "OnlineEventAttendanceMode", "MixedEventAttendanceMode"],
	applicationCategory: [
		"GameApplication", "SocialNetworkingApplication", "TravelApplication", "ShoppingApplication", "SportsApplication", "LifestyleApplication",
		"BusinessApplication", "DesignApplication", "DeveloperApplication", "DriverApplication", "EducationalApplication", "HealthApplication",
		"FinanceApplication", "SecurityApplication", "BrowserApplication", "CommunicationApplication", "DesktopEnhancementApplication",
		"EntertainmentApplication", "MultimediaApplication", "HomeApplication", "UtilitiesApplication", "ReferenceApplication",
	],
};

const DATE_PROPS = ["startDate", "endDate", "datePublished", "dateModified", "dateCreated", "datePosted", "uploadDate", "priceValidUntil", "validFrom", "validThrough", "foundingDate", "birthDate", "deathDate", "releaseDate", "availabilityStarts", "availabilityEnds", "expires"];
const URL_PROPS = ["url", "sameAs", "image", "logo", "thumbnailUrl", "contentUrl", "embedUrl", "downloadUrl", "installUrl", "screenshot", "serviceUrl", "hasMap", "discussionUrl", "softwareHelp"];
const PRICE_PROPS = ["price", "lowPrice", "highPrice", "minPrice", "maxPrice"];
const COUNT_PROPS = ["offerCount", "ratingCount", "reviewCount", "numberOfItems", "answerCount"];

/** Checks on one property's value, wherever it appears. */
const VALUE_CHECKS: Record<string, (value: unknown, prop: string) => string | null> = {
	...Object.fromEntries(
		PRICE_PROPS.map((p) => [
			p,
			(v: unknown) => {
				const n = numeric(v);
				if (n === null) return `${code(p)} should be a number, like 9.99 (no currency symbol or commas; 0 for free).`;
				return n < 0 ? `${code(p)} can't be negative.` : null;
			},
		]),
	),
	...Object.fromEntries(
		COUNT_PROPS.map((p) => [
			p,
			(v: unknown) => {
				const n = numeric(v);
				return n === null || !Number.isInteger(n) || n < 0 ? `${code(p)} should be a whole number.` : null;
			},
		]),
	),
	...Object.fromEntries(["ratingValue", "bestRating", "worstRating"].map((p) => [p, (v: unknown) => (numeric(v) === null ? `${code(p)} should be a number, like 4.5.` : null)])),
	...Object.fromEntries(
		DATE_PROPS.map((p) => [
			p,
			(v: unknown) => (typeof v === "string" && ISO_DATE.test(v.trim()) && !Number.isNaN(Date.parse(v)) ? null : `${code(p)} should be an ISO 8601 date, like 2026-11-09 or 2026-11-09T19:00:00-05:00.`),
		]),
	),
	...Object.fromEntries(
		URL_PROPS.map((p) => [
			p,
			(v: unknown) => (typeof v !== "string" || URLISH.test(v.trim()) ? null : `${code(p)} should be a full URL (https://…), a path like /pricing/, or a #name.`),
		]),
	),
	priceCurrency: (v) => {
		if (typeof v !== "string") return "`priceCurrency` should be a three-letter ISO 4217 code, like USD.";
		const value = v.trim();
		if (CURRENCIES.has(value)) return null;
		if (CURRENCIES.has(value.toUpperCase())) return `Write the currency code in capitals: ${value.toUpperCase()}.`;
		return `${code(value)} isn't an ISO 4217 currency code (like USD or EUR).`;
	},
	position: (v) => {
		const n = numeric(v);
		return n === null || !Number.isInteger(n) || n < 1 ? "`position` should be a whole number, 1 or more." : null;
	},
	...Object.fromEntries(
		Object.entries(ENUMS).map(([p, values]) => [
			p,
			(v: unknown) => {
				if (typeof v !== "string") return null;
				const short = v.trim().replace(/^https?:\/\/schema\.org\//i, "");
				if (values.includes(short)) return null;
				const fix = values.find((x) => x.toLowerCase() === short.toLowerCase());
				return fix ? `${code(v)} should be https://schema.org/${fix}.` : `${code(v)} isn't a value Google accepts for ${code(p)} (for example https://schema.org/${values[0]}).`;
			},
		]),
	),
};

// ── Types ────────────────────────────────────────────────────────

function ratingBounds(node: Obj, at: string, warn: Warn): void {
	const value = numeric(node.ratingValue);
	const best = numeric(node.bestRating) ?? 5;
	const worst = numeric(node.worstRating) ?? 1;
	if (best <= worst) warn(at, `bestRating (${best}) should be higher than worstRating (${worst}).`);
	else if (value !== null && (value < worst || value > best))
		warn(at, `ratingValue ${value} is outside ${worst}–${best}${node.bestRating === undefined && node.worstRating === undefined ? " (the default scale; set bestRating and worstRating for another)" : ""}.`);
}

/** The price of an offer, its own or in its priceSpecification. */
const offerHas = (node: Obj, prop: string) => present(node, prop) || list(node.priceSpecification).some((s) => isObj(s) && present(s, prop));

const PAGE_NODES = new Set(["WebPage", "AboutPage", "CheckoutPage", "CollectionPage", "ContactPage", "ItemPage", "MedicalWebPage", "ProfilePage", "SearchResultsPage", "RealEstateListing"]);

export const TYPE_RULES: Record<string, TypeRule> = {
	SoftwareApplication: {
		google: "software app rich results",
		required: ["name", "offers", ["aggregateRating", "review"]],
		recommended: ["applicationCategory", "operatingSystem"],
		check: (node, at, warn) => {
			if (!specMet(node, ["aggregateRating", "review"]) && !specMiscased(node, ["aggregateRating", "review"]))
				warn(at, "Without real ratings or reviews, Google shows no app rich result. Don't add ratings you don't have: the markup is still valid schema.org (or describe the app as a Service).", true);
		},
	},
	Product: {
		google: "product snippets",
		required: ["name", ["offers", "review", "aggregateRating"]],
		recommended: ["image", "description"],
	},
	Offer: {
		check: (node, at, warn) => {
			if (!offerHas(node, "price") && !("price" in node)) warn(at, "Add price: Google needs a price on every offer (0 for free).");
			if (!offerHas(node, "priceCurrency") && !("priceCurrency" in node) && !specMiscased(node, "priceCurrency")) warn(at, "Add priceCurrency, like USD.");
		},
	},
	AggregateOffer: {
		google: "price ranges",
		required: ["lowPrice", "priceCurrency"],
		recommended: ["highPrice", "offerCount"],
		check: (node, at, warn) => {
			const low = numeric(node.lowPrice);
			const high = numeric(node.highPrice);
			if (low !== null && high !== null && low > high) warn(at, `lowPrice (${low}) is higher than highPrice (${high}).`);
		},
	},
	PriceSpecification: { google: "prices", required: ["price", "priceCurrency"] },
	AggregateRating: {
		google: "review snippets",
		required: ["ratingValue", ["ratingCount", "reviewCount"]],
		check: (node, at, warn) => {
			ratingBounds(node, at, warn);
			for (const prop of ["ratingCount", "reviewCount"]) {
				const n = numeric(node[prop]);
				if (n === 0) warn(at, `${prop} is 0: a rating needs at least one real rating or review. Remove aggregateRating if there are none.`);
			}
		},
	},
	Rating: { google: "review snippets", required: ["ratingValue"], check: ratingBounds },
	Review: { google: "review snippets", required: ["author", "reviewRating"] },
	FAQPage: {
		google: "FAQ rich results",
		required: ["mainEntity"],
		note: "Google shows FAQ rich results only for well-known government and health sites; other search engines still read the markup.",
		check: (node, at, warn) => {
			list(node.mainEntity).forEach((q, i) => {
				if (isObj(q) && !typesOf(q).includes("Question")) warn(`${at}.mainEntity${Array.isArray(node.mainEntity) ? `[${i}]` : ""}`, "Each FAQ entry should be a Question.");
			});
		},
	},
	Question: {
		google: "FAQ and Q&A rich results",
		required: ["name", ["acceptedAnswer", "suggestedAnswer"]],
	},
	Answer: { google: "FAQ and Q&A rich results", required: ["text"] },
	BreadcrumbList: {
		google: "breadcrumbs",
		required: ["itemListElement"],
		check: (node, at, warn) => {
			const items = list(node.itemListElement);
			items.forEach((item, i) => {
				const where = `${at}.itemListElement[${i}]`;
				if (!isObj(item)) return warn(where, "Each breadcrumb should be a ListItem object.");
				if (numeric(item.position) !== i + 1) warn(where, `position should be ${i + 1} (breadcrumbs count from 1, in order).`);
				const named = present(item, "name") || (isObj(item.item) && present(item.item, "name"));
				if (!named) warn(where, "Add name: the text of this breadcrumb.");
				if (i < items.length - 1 && !present(item, "item")) warn(where, "Add item: the URL of this breadcrumb (only the last one may leave it out).");
			});
		},
	},
	Event: {
		google: "event rich results",
		required: ["name", "startDate", "location"],
		recommended: ["endDate", "eventStatus", "image", "description", "offers", "organizer"],
	},
	Course: {
		google: "course info",
		required: ["name", "description"],
		recommended: ["provider", "offers", "hasCourseInstance"],
	},
	Organization: { recommended: ["name", "url", "logo"] },
	Person: { required: ["name"] },
	Service: { recommended: ["name", "provider"] },
	ImageObject: { required: [["contentUrl", "url"]] },
	VideoObject: { google: "video rich results", required: ["name", "thumbnailUrl", "uploadDate"] },
};

/** Subtypes that follow a type's rules. */
const SUBTYPES: Record<string, string> = {
	WebApplication: "SoftwareApplication",
	MobileApplication: "SoftwareApplication",
	VideoGame: "SoftwareApplication",
	UnitPriceSpecification: "PriceSpecification",
	CompoundPriceSpecification: "PriceSpecification",
	EmployerAggregateRating: "AggregateRating",
	...Object.fromEntries(
		["Corporation", "LocalBusiness", "NewsMediaOrganization", "OnlineBusiness", "OnlineStore", "EducationalOrganization", "NGO", "GovernmentOrganization", "MedicalOrganization", "SportsOrganization", "PerformingGroup", "Restaurant", "Store", "ProfessionalService"].map((t) => [t, "Organization"]),
	),
	...Object.fromEntries(["BusinessEvent", "MusicEvent", "EducationEvent", "Festival", "SportsEvent", "TheaterEvent", "ComedyEvent", "SocialEvent"].map((t) => [t, "Event"])),
};

/** The type a nested object under this property should have (it's checked as one when it has none). */
const EXPECTED_TYPE: Record<string, string> = {
	offers: "Offer",
	aggregateRating: "AggregateRating",
	reviewRating: "Rating",
	review: "Review",
	acceptedAnswer: "Answer",
	suggestedAnswer: "Answer",
	address: "PostalAddress",
	location: "Place",
	priceSpecification: "UnitPriceSpecification",
	itemListElement: "ListItem",
	hasCourseInstance: "CourseInstance",
	availableChannel: "ServiceChannel",
	geo: "GeoCoordinates",
	contactPoint: "ContactPoint",
};

// ── Names ────────────────────────────────────────────────────────

/** Common schema.org property names, to catch the same name in the wrong case. */
const KNOWN_PROPERTIES = (
	"about abstract acceptedAnswer acceptedPaymentMethod accessibilityFeature accountablePerson actor additionalName additionalProperty additionalType " +
	"address addressCountry addressLocality addressRegion aggregateRating alternateName alternativeHeadline alumniOf amenityFeature answerCount " +
	"applicableCountry applicationCategory applicationSubCategory applicationSuite areaServed articleBody articleSection associatedMedia audience " +
	"audienceType author availability availabilityEnds availabilityStarts availableAtOrFrom availableChannel availableDeliveryMethod availableLanguage " +
	"award baseSalary bestRating birthDate birthPlace bookFormat brand breadcrumb browserRequirements businessFunction caption category character " +
	"citation closes color colleague comment commentCount contactPoint contactType contentLocation contentRating contentSize contentUrl contributor " +
	"cookTime copyrightHolder copyrightYear countriesNotSupported countriesSupported countryOfOrigin courseCode courseMode coursePrerequisites " +
	"courseWorkload creator currenciesAccepted dateCreated dateModified datePosted datePublished dayOfWeek deathDate deathPlace deliveryTime depth " +
	"description director disambiguatingDescription discussionUrl doorTime downloadUrl duns duration editor educationalCredentialAwarded " +
	"educationalLevel eligibleQuantity eligibleRegion email embedUrl employee employmentType encodingFormat endDate endTime episodeNumber " +
	"eventAttendanceMode eventSchedule eventStatus expires familyName faxNumber featureList fileSize founder foundingDate foundingLocation funder " +
	"gender geo givenName gtin gtin12 gtin13 gtin14 gtin8 hasCourseInstance hasMap hasMenu hasMerchantReturnPolicy hasOccupation hasOfferCatalog " +
	"hasPart hasVariant headline height highPrice hiringOrganization homeLocation honorificPrefix honorificSuffix identifier image inLanguage " +
	"ineligibleRegion installUrl interactionStatistic interactionType inventoryLevel isAccessibleForFree isBasedOn isFamilyFriendly isPartOf isbn " +
	"isicV4 itemCondition itemListElement itemListOrder itemOffered itemReviewed jobLocation jobTitle keywords knowsAbout knowsLanguage latitude " +
	"legalName leiCode license location logo longitude lowPrice mainEntity mainEntityOfPage makesOffer manufacturer material maxPrice maxValue " +
	"member memberOf menu merchantReturnDays minPrice minValue model mpn naics name nationality numberOfEmployees numberOfItems numberOfPages " +
	"offerCount offers openingHours openingHoursSpecification opens operatingSystem organizer owns parentOrganization paymentAccepted performer " +
	"permissions position postalCode potentialAction prepTime price priceCurrency priceRange priceSpecification priceValidUntil primaryImageOfPage " +
	"producer productID provider publisher publishingPrinciples ratingCount ratingValue recipeCategory recipeCuisine recipeIngredient " +
	"recipeInstructions recipeYield releaseDate releaseNotes returnFees returnMethod returnPolicyCategory review reviewBody reviewCount reviewRating " +
	"sameAs screenshot seller serviceArea serviceOutput servicePhone serviceType serviceUrl shippingDestination shippingDetails shippingRate size " +
	"sku slogan softwareHelp softwareRequirements softwareVersion sponsor startDate startTime step streetAddress subOrganization subjectOf " +
	"suggestedAnswer supply target taxID teaches telephone termsOfService text thumbnail thumbnailUrl tickerSymbol timeRequired tool totalTime " +
	"translator typicalAgeRange unitCode unitText uploadDate url urlTemplate validFrom validThrough value valueAddedTaxIncluded vatID version " +
	"video weight width wordCount workExample workLocation worksFor worstRating"
).split(" ");
const PROPERTY_CASE = new Map(KNOWN_PROPERTIES.map((p) => [p.toLowerCase(), p]));
const PROPERTY_SET = new Set(KNOWN_PROPERTIES);

/** Common schema.org types, for the same check on @type. */
const KNOWN_TYPES = (
	"Thing CreativeWork WebSite WebPage AboutPage CheckoutPage CollectionPage ContactPage FAQPage ItemPage MedicalWebPage ProfilePage QAPage " +
	"SearchResultsPage RealEstateListing Article BlogPosting NewsArticle TechArticle Report ScholarlyArticle DiscussionForumPosting " +
	"SocialMediaPosting Comment Organization Corporation LocalBusiness NewsMediaOrganization OnlineBusiness OnlineStore EducationalOrganization NGO " +
	"GovernmentOrganization MedicalOrganization SportsOrganization PerformingGroup ProfessionalService Restaurant Store Person Place PostalAddress " +
	"GeoCoordinates ContactPoint Country State City AdministrativeArea VirtualLocation ImageObject VideoObject AudioObject MediaObject Clip " +
	"Product ProductGroup ProductModel Brand Offer AggregateOffer OfferCatalog PriceSpecification UnitPriceSpecification CompoundPriceSpecification " +
	"MonetaryAmount QuantitativeValue AggregateRating Rating Review EmployerAggregateRating Service ServiceChannel FinancialProduct " +
	"SoftwareApplication WebApplication MobileApplication VideoGame Event BusinessEvent MusicEvent EducationEvent Festival SportsEvent " +
	"TheaterEvent ComedyEvent SocialEvent Course CourseInstance Question Answer HowTo HowToStep HowToSection HowToTip Recipe BreadcrumbList " +
	"ItemList ListItem SearchAction EntryPoint Action Book Movie MusicRecording MusicAlbum PodcastSeries PodcastEpisode Dataset JobPosting " +
	"OpeningHoursSpecification DayOfWeek Audience DefinedTerm DefinedTermSet Language Occupation MerchantReturnPolicy OfferShippingDetails " +
	"ShippingDeliveryTime PropertyValue InteractionCounter BroadcastEvent ClaimReview LearningResource Quiz VacationRental LodgingBusiness " +
	"Hotel Vehicle Car"
).split(" ");
const TYPE_CASE = new Map(KNOWN_TYPES.map((t) => [t.toLowerCase(), t]));

// ── The walk ─────────────────────────────────────────────────────

/** Spec as text: "name", "aggregateRating or review". */
const specText = (spec: Spec) => (Array.isArray(spec) ? spec.join(" or ") : spec);
const specMet = (node: Obj, spec: Spec) => (Array.isArray(spec) ? spec : [spec]).some((p) => present(node, p));
/** Written in the wrong case, or there but empty (reported as that instead). */
const specMiscased = (node: Obj, spec: Spec) =>
	(Array.isArray(spec) ? spec : [spec]).some((p) => Object.keys(node).some((k) => k.toLowerCase() === p.toLowerCase() && (k !== p || isEmpty(node[k]))));

function lintObject(node: Obj, at: string, warn: Warn, expected: string | undefined, depth: number): void {
	const types = typesOf(node);
	const pureRef = typeof node["@id"] === "string" && Object.keys(node).every((k) => k === "@id" || k === "@type");
	if (!types.length && expected && !pureRef) warn(at, `Add "@type": "${expected}".`);
	for (const t of types) {
		const fix = TYPE_CASE.get(t.toLowerCase());
		if (fix && fix !== t) warn(at, `@type ${code(t)} should be ${code(fix)}: schema.org names are case-sensitive.`);
	}
	if (!pureRef) {
		const seen = new Set<TypeRule>();
		for (const t of types.length ? types : expected ? [expected] : []) {
			const rule = TYPE_RULES[t] ?? TYPE_RULES[SUBTYPES[t] ?? ""];
			if (!rule || seen.has(rule)) continue;
			seen.add(rule);
			for (const spec of rule.required ?? [])
				if (!specMet(node, spec) && !specMiscased(node, spec))
					warn(at, `Add ${specText(spec)}: ${rule.google ? `Google requires it for ${rule.google}` : "it's required"}.`);
			// Recommended properties for the rule's own nodes only (not every nested organization or offer).
			if (depth === 0) for (const spec of rule.recommended ?? []) if (!specMet(node, spec) && !specMiscased(node, spec)) warn(at, `${specText(spec)} is recommended.`, true);
			rule.check?.(node, at, warn);
			if (rule.note) warn(at, rule.note, true);
		}
	}
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("@")) continue;
		const where = `${at}.${key}`;
		if (!PROPERTY_SET.has(key)) {
			const fix = PROPERTY_CASE.get(key.toLowerCase());
			if (fix) warn(where, `${code(key)} should be ${code(fix)}: schema.org names are case-sensitive.`);
		}
		if (isEmpty(value)) {
			warn(where, `${code(key)} is empty: fill it in or remove it.`);
			continue;
		}
		const check = VALUE_CHECKS[key];
		const items = list(value);
		items.forEach((item, i) => {
			const itemAt = Array.isArray(value) ? `${where}[${i}]` : where;
			if (isEmpty(item)) warn(itemAt, "This item is empty: remove it.");
			else if (isObj(item)) {
				if (depth < 24) lintObject(item, itemAt, warn, EXPECTED_TYPE[key], depth + 1);
			} else if (check) {
				const problem = check(item, key);
				if (problem) warn(itemAt, problem);
			}
		});
	}
}

/** Warnings for a rule's nodes (as parsed, before references are resolved). */
export function lintNodes(nodes: Obj[], options: LintOptions = {}): LintWarning[] {
	const out: LintWarning[] = [];
	const seen = new Set<string>();
	const warn: Warn = (at, message, note) => {
		const key = `${at}\n${message}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(note ? { at, message, note: true } : { at, message });
	};
	const counts = new Map<string, number>();
	nodes.forEach((node) => {
		const type = typesOf(node)[0] ?? "Node";
		counts.set(type, (counts.get(type) ?? 0) + 1);
	});
	const index = new Map<string, number>();
	nodes.forEach((node) => {
		const type = typesOf(node)[0] ?? "Node";
		const n = (index.get(type) ?? 0) + 1;
		index.set(type, n);
		const at = (counts.get(type) ?? 0) > 1 ? `${type} ${n}` : type;
		if (options.graph && typesOf(node).some((t) => t === "WebSite"))
			warn(at, 'The pack\'s graph already has the site\'s WebSite: link to it with {"@id": "#website"} instead of adding another.');
		if (options.graph && typesOf(node).some((t) => PAGE_NODES.has(t)))
			warn(at, 'The pack\'s graph already has this page\'s WebPage: set its type on the Types or Overrides tab, or link to it with {"@id": "#webpage"}.');
		lintObject(node, at, warn, undefined, 0);
	});
	return out;
}

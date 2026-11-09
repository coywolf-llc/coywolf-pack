/**
 * Starting points for custom markup, inserted by the editor's template
 * picker. Empty strings are the parts to fill in (the lint flags any left
 * empty). They link to the pack's own nodes with {"@id": "#organization"}
 * (the publisher from Site details), which resolves to its real @id when the
 * Schema.org graph is on. Add one by adding an entry.
 */

export interface MarkupTemplate {
	label: string;
	/** What the template is for, shown under the picker. */
	hint: string;
	node: Record<string, unknown>;
}

const offer = (extra: Record<string, unknown> = {}) => ({ "@type": "Offer", name: "", price: "0", priceCurrency: "USD", ...extra });

export const MARKUP_TEMPLATES: Record<string, MarkupTemplate> = {
	Service: {
		label: "Service",
		hint: "A service or subscription your organization provides, with its plans as offers.",
		node: {
			"@type": "Service",
			"@id": "#service",
			name: "",
			description: "",
			serviceType: "",
			url: "/",
			provider: { "@id": "#organization" },
			areaServed: "Worldwide",
			availableChannel: { "@type": "ServiceChannel", serviceUrl: "" },
			offers: [offer(), offer({ price: "" })],
		},
	},
	WebApplication: {
		label: "Web application",
		hint: "An app that runs in the browser. Google shows app rich results only with real ratings or reviews.",
		node: {
			"@type": "WebApplication",
			"@id": "#app",
			name: "",
			description: "",
			url: "",
			applicationCategory: "BusinessApplication",
			operatingSystem: "Any",
			browserRequirements: "Requires JavaScript",
			creator: { "@id": "#organization" },
			offers: offer(),
		},
	},
	Product: {
		label: "Product",
		hint: "Something you sell, with its price and availability.",
		node: {
			"@type": "Product",
			"@id": "#product",
			name: "",
			description: "",
			image: "",
			sku: "",
			brand: { "@type": "Brand", name: "" },
			offers: offer({ url: "", availability: "https://schema.org/InStock" }),
		},
	},
	FAQPage: {
		label: "FAQ page",
		hint: "Questions and answers shown on the page.",
		node: {
			"@type": "FAQPage",
			mainEntity: [
				{ "@type": "Question", name: "", acceptedAnswer: { "@type": "Answer", text: "" } },
				{ "@type": "Question", name: "", acceptedAnswer: { "@type": "Answer", text: "" } },
			],
		},
	},
	Event: {
		label: "Event",
		hint: "An event with a date, a place and tickets.",
		node: {
			"@type": "Event",
			"@id": "#event",
			name: "",
			description: "",
			startDate: "",
			endDate: "",
			eventStatus: "https://schema.org/EventScheduled",
			eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
			location: {
				"@type": "Place",
				name: "",
				address: { "@type": "PostalAddress", streetAddress: "", addressLocality: "", addressRegion: "", postalCode: "", addressCountry: "US" },
			},
			image: "",
			organizer: { "@id": "#organization" },
			offers: offer({ url: "", availability: "https://schema.org/InStock", validFrom: "" }),
		},
	},
	Organization: {
		label: "Organization",
		hint: "Another organization, such as a brand or a partner (the publisher itself is set on Site details).",
		node: {
			"@type": "Organization",
			"@id": "#brand",
			name: "",
			url: "",
			logo: "",
			sameAs: [""],
			parentOrganization: { "@id": "#organization" },
		},
	},
	Person: {
		label: "Person",
		hint: "A person who isn't a byline (bylines are set on the Authors tab).",
		node: {
			"@type": "Person",
			"@id": "#team-member",
			name: "",
			jobTitle: "",
			url: "",
			image: "",
			sameAs: [""],
			worksFor: { "@id": "#organization" },
		},
	},
};

/** A template as editor text. */
export function templateText(key: string): string {
	const template = MARKUP_TEMPLATES[key];
	return template ? JSON.stringify(template.node, null, "\t") : "";
}

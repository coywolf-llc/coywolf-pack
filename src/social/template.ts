/**
 * The social image template: one HTML page, 1200×630, with the entry's
 * title, the site's name and logo, in the site's colors. Cloudflare Browser
 * Run takes a screenshot of it (render.ts); the admin previews the same HTML
 * in a frame. Pure (no I/O), so tests can load it.
 *
 * Why HTML and a headless browser: a renderer inside the Worker (Satori and
 * Yoga for layout, resvg's WebAssembly build to rasterize) adds about 3 MB to
 * every site's bundle (roughly 1.3 MB compressed, against Workers Free's 3 MB
 * for the whole Worker), plus the font files it needs, and its rasterizing
 * costs CPU time in the request, for a job that runs once per entry. Browser
 * Run renders real text with real fonts, costs a second or two of browser
 * time per image, and adds nothing to the bundle. See docs/social-images.md.
 */

export const WIDTH = 1200;
export const HEIGHT = 630;
/** Bump when the template's markup changes, so every image is made again. */
export const TEMPLATE_VERSION = 1;

export interface TemplateSettings {
	background: string;
	text: string;
	accent: string;
	/** Where the title sits. */
	layout: "left" | "center";
	showLogo: boolean;
	showSiteName: boolean;
}

export const TEMPLATE_DEFAULTS: TemplateSettings = {
	background: "#0f172a",
	text: "#f8fafc",
	accent: "#38bdf8",
	layout: "left",
	showLogo: true,
	showSiteName: true,
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeTemplate(raw: unknown): TemplateSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof TemplateSettings, unknown>>;
	const color = (v: unknown, fallback: string) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim().toLowerCase() : fallback);
	return {
		background: color(r.background, TEMPLATE_DEFAULTS.background),
		text: color(r.text, TEMPLATE_DEFAULTS.text),
		accent: color(r.accent, TEMPLATE_DEFAULTS.accent),
		layout: r.layout === "center" ? "center" : "left",
		showLogo: typeof r.showLogo === "boolean" ? r.showLogo : TEMPLATE_DEFAULTS.showLogo,
		showSiteName: typeof r.showSiteName === "boolean" ? r.showSiteName : TEMPLATE_DEFAULTS.showSiteName,
	};
}

export interface TemplateInput {
	title: string;
	siteName: string;
	/** The logo as a data: URL or an absolute https URL; null leaves it out. */
	logo: string | null;
	settings: TemplateSettings;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** A font size that fits the title in at most four lines. */
export function titleSize(title: string): number {
	const n = [...title].length;
	if (n <= 32) return 84;
	if (n <= 55) return 72;
	if (n <= 85) return 60;
	if (n <= 120) return 52;
	return 44;
}

/** Only data: images and https URLs reach the template. */
const safeImage = (src: string | null): string | null => (src && (/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(src) || /^https:\/\/[^\s"'<>]+$/.test(src)) ? src : null);

/** The page Browser Run takes a screenshot of (and the admin previews). Self-contained: no scripts, no outside requests but the logo's. */
export function socialImageHtml(input: TemplateInput): string {
	const s = input.settings;
	const title = input.title.trim().replace(/\s+/g, " ").slice(0, 200) || input.siteName || "Untitled";
	const logo = s.showLogo ? safeImage(input.logo) : null;
	const site = s.showSiteName ? input.siteName.trim().slice(0, 80) : "";
	const center = s.layout === "center";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}
html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
body{background:${s.background};color:${s.text};font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;display:flex;flex-direction:column;justify-content:space-between;${center ? "align-items:center;text-align:center;" : ""}padding:80px 88px 72px;position:relative}
.accent{position:absolute;${center ? "left:0;right:0;top:0;height:14px" : "left:0;top:0;bottom:0;width:18px"};background:${s.accent}}
h1{margin:0;font-size:${titleSize(title)}px;line-height:1.12;font-weight:800;letter-spacing:-0.015em;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;text-wrap:balance;overflow-wrap:anywhere}
footer{display:flex;align-items:center;gap:22px;font-size:32px;font-weight:600;min-height:72px}
footer img{height:72px;width:auto;max-width:300px;object-fit:contain}
footer span{opacity:.85}
</style></head><body><div class="accent"></div><h1>${escapeHtml(title)}</h1><footer>${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ""}${site ? `<span>${escapeHtml(site)}</span>` : ""}</footer></body></html>`;
}

/**
 * What the image depends on, as a short hash: a change to the title, the site
 * name, the logo or the template makes a new image (with a new file name, so
 * caches never serve the old one).
 */
export async function imageHash(input: { title: string; siteName: string; logoKey: string | null; settings: TemplateSettings }): Promise<string> {
	const text = JSON.stringify([TEMPLATE_VERSION, input.title.trim(), input.siteName.trim(), input.logoKey ?? "", input.settings]);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where an entry's image is stored in the media bucket. */
export const imageKey = (collection: string, id: string, hash: string) => `coywolf-og/${collection}/${id}-${hash}.png`;

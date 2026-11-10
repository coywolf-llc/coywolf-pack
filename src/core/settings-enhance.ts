/**
 * EmDash's generic plugin Settings page
 * (/_emdash/admin/plugins-manager/coywolf-pack/settings), made short. EmDash
 * renders that page from the settings schema, shows each field's description
 * as plain text and can't hide a field, so the pack middleware adds this small
 * script to admin pages. On that page it:
 *
 * - swaps the description of the four fields people fill in (the Cloudflare
 *   API token, the AI, Fathom and Google keys) for a short line plus the
 *   guides in closed <details> (the same ones the module pages show);
 * - hides the older tokens the Cloudflare API token replaces while they're
 *   empty, and puts the saved ones behind a closed "Older tokens (N)" toggle;
 * - hides the Videos webhook secret, which the pack fills in itself.
 *
 * A secret is saved when EmDash shows its "Clear stored value" button: a
 * button[type=button] beside the field, rendered only for a set secret, so it
 * works in any admin language. A field once seen saved stays with the older
 * tokens after Clear is selected, so the change can still be undone.
 *
 * Progressive enhancement: it never moves EmDash's (React's) nodes, only sets
 * `hidden` and attributes on them in place and adds its own nodes beside them.
 * It looks fields up by their label, and if EmDash's markup ever changes it
 * leaves the page as EmDash renders it, with the short plain-text descriptions
 * from secrets.ts. test/emdash-contract.test.mjs checks the markup it relies on.
 */
import { GUIDES, SETTINGS_PAGE_GUIDES, guideHtml } from "./guide-content.js";
import { HIDDEN_SECRET_KEYS, OLDER_SECRET_KEYS, SECRET_SETTINGS } from "./secrets.js";

const PAGE = /\/_emdash\/admin\/plugins-manager\/coywolf-pack\/settings\/?$/;

/** The toggle's one-line explanation. */
export const OLDER_TOKENS_NOTE = "These still work. After you save the Cloudflare API token, select Clear stored value on each, then Save Settings.";

const labelOf = (key: string) => (SECRET_SETTINGS as Record<string, { label: string }>)[key]?.label;

/** Label text → the HTML that replaces that field's description. */
export function settingsGuideHtml(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(SETTINGS_PAGE_GUIDES)) {
		const label = labelOf(key);
		if (!label) continue;
		const guides = entry.guides.map((id) => guideHtml(GUIDES[id])).join("");
		out[label] = `<p class="text-sm leading-snug text-kumo-subtle" data-cw-intro>${entry.intro}</p><div class="space-y-2">${guides}</div>`;
	}
	return out;
}

/** What the script needs: the guides by label, the older fields' labels and the hidden fields' labels. */
export function settingsPageData(): { guides: Record<string, string>; older: string[]; hidden: string[] } {
	const labels = (keys: readonly string[]) => keys.map(labelOf).filter((label): label is string => Boolean(label));
	return { guides: settingsGuideHtml(), older: labels(OLDER_SECRET_KEYS), hidden: labels(HIDDEN_SECRET_KEYS) };
}

/** Built once per isolate: its content only changes with a deploy. */
let enhanceScript: string | null = null;

/** JSON that can't close the <script> element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

/**
 * The inline script. It goes on every admin page, not just the Settings page:
 * the admin is a single-page app, so a visit that starts elsewhere reaches
 * Settings without a page load (the script checks the path itself). It runs
 * again on each DOM change (once a frame at most) and does only what isn't
 * done yet, so React's re-renders (a save, Clear stored value) keep it right.
 */
export function settingsEnhanceScript(): string {
	enhanceScript ??= buildEnhanceScript();
	return enhanceScript;
}

function buildEnhanceScript(): string {
	const data = settingsPageData();
	return `(function(){var D=${scriptJson(data.guides)};var O=${scriptJson(data.older)};var H=${scriptJson(data.hidden)};var N=${scriptJson(OLDER_TOKENS_NOTE)};var P=${PAGE.toString()};var q=0;
function cleared(w){for(var c=w.firstElementChild;c;c=c.nextElementSibling)if(c.tagName==="BUTTON"&&c.getAttribute("type")==="button")return true;return false;}
function run(){q=0;if(!P.test(location.pathname))return;var f=document.getElementById("plugin-settings-form");if(!f)return;var older=[],first=null;
f.querySelectorAll("input[aria-labelledby]").forEach(function(i){var l=document.getElementById(i.getAttribute("aria-labelledby"));var t=l&&l.textContent.trim();if(!t)return;
var h=D[t];if(h&&!i.getAttribute("data-cw-guide")){var d=document.getElementById(i.getAttribute("aria-describedby")||"");if(d&&d.parentNode){
var b=document.createElement("div");b.className="col-span-full space-y-2";b.setAttribute("data-cw-guides","");b.innerHTML=h;
var p=b.querySelector("[data-cw-intro]");p.id=d.id+"-cw";d.hidden=true;d.parentNode.insertBefore(b,d.nextSibling);
i.setAttribute("aria-describedby",p.id);i.setAttribute("data-cw-guide","1");}}
var k=H.indexOf(t)>=0?"hidden":O.indexOf(t)>=0?"older":"";if(!k)return;
var w=i.parentElement&&i.parentElement.parentElement;if(!w||w===f||w.querySelectorAll("input").length!==1)return;
if(k==="hidden"){w.hidden=true;return;}
if(!first)first=w;if(cleared(w))w.setAttribute("data-cw-older","");
if(w.hasAttribute("data-cw-older"))older.push(w);else w.hidden=true;});
var g=f.querySelector("[data-cw-older-toggle]");
if(!older.length){if(g)g.hidden=true;return;}
if(!g){g=document.createElement("div");g.className="space-y-1";g.setAttribute("data-cw-older-toggle","");
var x=document.createElement("button");x.type="button";x.className="inline-flex min-h-6 cursor-pointer items-center gap-1 py-1 text-sm font-medium text-kumo-link underline";x.setAttribute("aria-expanded","false");
x.innerHTML='<span aria-hidden="true"></span><span></span>';
x.addEventListener("click",function(){x.setAttribute("aria-expanded",x.getAttribute("aria-expanded")==="true"?"false":"true");run();});
var n=document.createElement("p");n.className="text-sm text-kumo-subtle";n.textContent=N;g.appendChild(x);g.appendChild(n);first.parentNode.insertBefore(g,first);}
g.hidden=false;var btn=g.querySelector("button");var open=btn.getAttribute("aria-expanded")==="true";
var arrow=open?"\\u25be":"\\u25b8",label="Older tokens ("+older.length+")";
if(btn.firstChild.textContent!==arrow)btn.firstChild.textContent=arrow;if(btn.lastChild.textContent!==label)btn.lastChild.textContent=label;
older.forEach(function(w){w.hidden=!open;});}
function later(){if(!q)q=requestAnimationFrame(run);}
new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true});later();})();`;
}

/** Add the script to an admin HTML page. Returns the response unchanged when it isn't HTML. */
export async function injectAdminEnhancements(response: Response): Promise<Response> {
	if (!(response.headers.get("content-type") ?? "").includes("text/html") || response.status !== 200) return response;
	const html = await response.text();
	const at = html.lastIndexOf("</body>");
	const script = `<script data-coywolf-pack>${settingsEnhanceScript()}</script>`;
	const body = at === -1 ? html + script : html.slice(0, at) + script + html.slice(at);
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	const out = new Response(body, { status: response.status, statusText: response.statusText, headers });
	// Astro keeps cookies set during the request on the response under this symbol; a new
	// Response drops it, which would lose session cookies (EmDash's middleware does the same).
	const cookies = Symbol.for("astro.cookies");
	const value = (response as unknown as Record<symbol, unknown>)[cookies];
	if (value !== undefined) (out as unknown as Record<symbol, unknown>)[cookies] = value;
	return out;
}

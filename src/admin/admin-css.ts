// The admin pages render inside EmDash's admin, whose stylesheet is a precompiled
// Tailwind build: a utility class it doesn't already contain does nothing. For the
// layouts it has no class for (responsive variants, arbitrary grid templates, sticky
// panels), the pack ships these rules under its own cw- names, so they can't collide
// with a Tailwind class a future EmDash build adds. Breakpoints match Tailwind's
// (sm 40rem, md 48rem, lg 64rem) and colors use EmDash's kumo tokens.
//
// These rules are unlayered, so they win over EmDash's @layer utilities: each class
// carries its own hidden state (cw-lg-block is display:none below lg) rather than
// pairing with Tailwind's `hidden`.
//
// test/admin-classes.test.mjs fails when an admin className is in neither EmDash's
// stylesheet nor this file.

export const SAVE_BAR_CSS = `@keyframes cw-save-bar-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.cw-save-bar{animation:cw-save-bar-in 160ms ease-out}
@media (prefers-reduced-motion: reduce){.cw-save-bar{animation:none}}`;

export const ADMIN_CSS = `.cw-fill-tint{fill:var(--color-kumo-tint)}
.cw-stroke-line{stroke:var(--color-kumo-line)}
.cw-accent-current{accent-color:currentColor}
.cw-field-icon{bottom:.625rem}
.cw-w-60{width:15rem}
.cw-overflow-auto{overflow:auto}
.cw-ps-6{padding-inline-start:1.5rem}
.cw-md-flex,.cw-md-table-cell,.cw-lg-block{display:none}
@media (min-width:40rem){
.cw-sm-cols-8-fill{grid-template-columns:8rem minmax(0,1fr)}
}
@media (min-width:48rem){
.cw-md-flex{display:flex}
.cw-md-row{flex-direction:row;align-items:center}
.cw-md-w-60{width:15rem}
.cw-md-table-cell{display:table-cell}
}
@media (min-width:64rem){
.cw-lg-block{display:block}
.cw-lg-cols-6{grid-template-columns:repeat(6,minmax(0,1fr))}
.cw-lg-cols-20-fill{grid-template-columns:minmax(0,20rem) minmax(0,1fr)}
.cw-lg-cols-24-fill{grid-template-columns:minmax(0,24rem) minmax(0,1fr)}
.cw-lg-cols-fill-24{grid-template-columns:minmax(0,1fr) minmax(0,24rem);align-items:start}
.cw-lg-sticky{position:sticky;top:1rem}
}`;

const STYLE_ID = "cw-pack-admin-css";

/** Adds the pack's admin CSS to the page once (a no-op outside the browser). */
export function injectAdminCss(): void {
	if (typeof document === "undefined") return;
	let style = document.getElementById(STYLE_ID);
	if (!style) {
		style = document.createElement("style");
		style.id = STYLE_ID;
		document.head.appendChild(style);
	}
	if (style.textContent !== ADMIN_CSS) style.textContent = ADMIN_CSS;
}

declare module "cloudflare:workers" {
	export const env: Record<string, unknown>;
	export function waitUntil(promise: Promise<unknown>): void;
}

/** Optional peer (src/forms.ts only); the site that uses private form uploads has it installed. */
declare module "@emdash-cms/plugin-forms" {
	// any: EmDash's ResolvedPlugin; wrapFormsPlugin reads it loosely.
	export function createPlugin(options?: Record<string, unknown>): any;
}

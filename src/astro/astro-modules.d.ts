/** Lets tsc type-check imports of .astro components (Astro compiles them; tsc only needs their shape). */
declare module "*.astro" {
	// any: Astro component factory.
	const Component: (props: any) => any;
	export default Component;
}

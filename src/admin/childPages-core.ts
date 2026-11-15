/**
 * The Child Pages page's logic (src/admin/childPages.tsx), kept free of React so Node can test it:
 * which collection the page tree shows, and the wording of the changes that moved pages.
 */

export interface CollectionStatus {
	collection: string;
	label: string;
	field: boolean;
	conflict: string | null;
	urlPattern: string | null;
	nests: "configured" | "field" | "override" | "pattern" | null;
}

export interface RuleRef {
	source: string;
	target: string;
}

/** A page that moved (src/childPages/pack.ts). */
export interface MoveRef {
	entryId: string;
	title: string;
	from: string;
	to: string;
}

export interface LoopRef extends MoveRef {
	rule: RuleRef;
}

export interface Shadow {
	url: string;
	rule: RuleRef;
}

export interface ChangeStatus {
	at: string;
	collection: string;
	label: string;
	reason: string;
	/** The page the change was made to: its title, and its URL (after the change, else before it), as far as they're known. */
	page?: { title?: string; url?: string };
	moved: number;
	written: number;
	skipped: number;
	redirectsOff: boolean;
	loops?: LoopRef[];
	shadowed?: Shadow[];
	noSnapshot?: boolean;
	failed?: string;
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The collection the page tree shows, from the collections as they are now: the one chosen while it
 * still has its Parent page field, else Pages, else the first with the field, and "" when none has it.
 * Worked out on every render, so a field added after the page loaded (Set up) gets its tree at once.
 */
export function treeCollection(collections: readonly Pick<CollectionStatus, "collection" | "field">[], chosen: string | null): string {
	const withField = collections.filter((c) => c.field);
	if (chosen && withField.some((c) => c.collection === chosen)) return chosen;
	return withField.find((c) => c.collection === "pages")?.collection ?? withField[0]?.collection ?? "";
}

/**
 * What happened, to follow the change's date ("…: “Coywolf Pack” was published"): a change to one page
 * names it by its title, or by its URL when it has none; one whose page isn't known stays "a page was published".
 */
export function changeReason(change: Pick<ChangeStatus, "reason" | "page">): string {
	const title = change.page?.title?.trim();
	const url = change.page?.url?.trim();
	const name = title ? `“${title}”` : url ? `the page at ${url}` : null;
	const about = /^A page('s)? (.+)$/.exec(change.reason);
	if (!name || !about) return change.reason.toLowerCase();
	// "A page's slug changed" → "the slug of “Coywolf Pack” changed".
	const owned = about[1] ? /^(\S+) (.+)$/.exec(about[2] as string) : null;
	if (owned) return `the ${owned[1]} of ${name} ${owned[2]}`;
	return `${name} ${about[2]}`;
}

/** What the change did to the other pages and their redirects. */
export function changeText(change: ChangeStatus): string {
	if (change.failed) return `The redirects for this change couldn't be worked out (${change.failed}). Click Re-check redirects to make them.`;
	// A change to one page ("A page was published") counts the pages that moved with it; Slug changes redirects the page itself.
	const parts = [/^A page\b/.test(change.reason) ? `${plural(change.moved, "more page", "more pages")} moved with it` : `${plural(change.moved, "page", "pages")} moved`];
	if (change.redirectsOff) parts.push("no redirects (Redirect Manager or Slug changes was off)");
	else parts.push(`${plural(change.written, "redirect", "redirects")} added`);
	if (change.skipped) parts.push(`${plural(change.skipped, "page", "pages")} over the limit of 200 a change had to wait`);
	if (change.loops?.length) parts.push(`${plural(change.loops.length, "redirect", "redirects")} not added (a loop)`);
	const text = `${parts.join("; ")}.`;
	return change.noSnapshot ? `${text} There were no earlier URLs to compare with, so pages this change moved got no redirect. Tracking started again from the current URLs.` : text;
}

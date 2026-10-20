/**
 * Pure planning for "Slug changes" (feature "redirects.slugChanges"): what to do
 * with the redirect rules when a published entry's public URL changes. No
 * imports, so `node --test` can load this file.
 */

/** Rules this feature made carry a note starting with this, so it only ever edits its own. */
export const SLUG_NOTE_PREFIX = "Slug change:";

export interface PlanRule {
	id: string;
	source: string;
	target: string;
	note: string | null;
}

export type SlugPlan =
	| { kind: "none"; reason: string }
	| {
			kind: "apply";
			/** Our rules to delete: their source is the entry's URL again (renamed back), which they would shadow or loop. */
			deleteIds: string[];
			/** Our rules that pointed at the old URL: point them at the new one, so there's no chain. */
			retargetIds: string[];
			/** Create the old → new rule, or update our existing rule for the old URL. */
			upsert: { id?: string };
			/** A rule someone else made already answers the old URL: left alone. */
			keptManual?: PlanRule;
	  };

const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
export const isOurs = (rule: Pick<PlanRule, "note">) => (rule.note ?? "").startsWith(SLUG_NOTE_PREFIX);

/**
 * The plan for an entry whose URL went from `oldUrl` to `newUrl`.
 * `related` is every exact rule whose source or target is either URL (any note).
 */
export function planSlugChange(oldUrl: string | null, newUrl: string | null, related: PlanRule[]): SlugPlan {
	if (!oldUrl || !newUrl) return { kind: "none", reason: "no URL" };
	const from = trim(oldUrl);
	const to = trim(newUrl);
	if (from === to) return { kind: "none", reason: "unchanged" };
	const ours = related.filter(isOurs);
	const deleteIds = ours.filter((r) => trim(r.source) === to).map((r) => r.id);
	const retargetIds = ours.filter((r) => trim(r.target) === from && trim(r.source) !== to && trim(r.source) !== from).map((r) => r.id);
	const forOld = related.find((r) => trim(r.source) === from);
	if (forOld && !isOurs(forOld)) return { kind: "apply", deleteIds, retargetIds, upsert: {}, keptManual: forOld };
	return { kind: "apply", deleteIds, retargetIds, upsert: forOld ? { id: forOld.id } : {} };
}

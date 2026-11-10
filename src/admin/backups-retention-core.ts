/**
 * What the Backups page's Retention on Cloudflare card says about the bucket's rule, kept free of JSX so
 * tests can load it: the summary line and the warning when backups seem to have stopped.
 */

/** What the server found on the bucket (src/backups/retention.ts RetentionStatus), as far as these need it. */
interface StatusLike {
	byPrefix: Record<string, number | null>;
}

export const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** The prefixes the rule must cover (src/backups/retention.ts RETENTION_PREFIXES). */
export const AGING_PREFIXES = ["d1/", "media/changed/", "uploads/changed/"];

/** One line for what the rule does now, for the badge and the summary. Only an exact match is "On". */
export function lifecycleSummary(
	state: { status: StatusLike } | null,
	retentionDays: number,
): { badge: string; variant: "primary" | "secondary" | "outline" | "destructive"; text: string } {
	if (!state) return { badge: "Not checked", variant: "outline", text: "Select Check to see what the backup bucket does with old backups." };
	const { status } = state;
	const found = AGING_PREFIXES.map((p) => status.byPrefix[p]).filter((v): v is number => v !== null && v !== undefined);
	if (found.length === AGING_PREFIXES.length && found.every((d) => d === retentionDays)) {
		return { badge: "On", variant: "primary", text: `Cloudflare deletes backups ${days(retentionDays)} after they're made. The site doesn't delete them itself.` };
	}
	if (found.some((d) => d < retentionDays)) {
		return {
			badge: "Deletes sooner",
			variant: "destructive",
			text: `The bucket's rule deletes backups after ${[...new Set(found)].map(days).join(" or ")}, sooner than Keep backups for (${days(retentionDays)}). Update the rule, or backups are deleted before the setting says. The site prunes as well until they match.`,
		};
	}
	if (found.length === AGING_PREFIXES.length) {
		return {
			badge: "Different",
			variant: "secondary",
			text: `The bucket's rule deletes backups after ${[...new Set(found)].map(days).join(" or ")}, but Keep backups for says ${days(retentionDays)}. Update the rule to match. Until then the site deletes them itself.`,
		};
	}
	if (found.length) {
		return { badge: "Partly", variant: "secondary", text: "A lifecycle rule covers only some of the backup folders. Set the rule to cover all of them. Until then the site deletes old backups itself." };
	}
	return { badge: "Off", variant: "outline", text: `No lifecycle rule yet: the site deletes backups older than ${days(retentionDays)} once a day.` };
}

/** The newest backup is older than half the retention days while the rule deletes by age: a warning to show. */
export function backupsStoppedWarning(newestBackup: string | null | undefined, retentionDays: number, ruleOn: boolean, now = Date.now()): string | null {
	if (!ruleOn) return null;
	const ageDays = newestBackup ? (now - Date.parse(newestBackup)) / 86_400_000 : Number.POSITIVE_INFINITY;
	if (ageDays <= retentionDays / 2) return null;
	return newestBackup
		? `The newest backup is ${Math.floor(ageDays)} days old, and the lifecycle rule keeps deleting backups older than ${days(retentionDays)}. Fix the backups soon, or none will be left.`
		: "There are no backups, and the lifecycle rule deletes any older than the retention days. Make a backup now.";
}


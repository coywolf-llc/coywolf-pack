/**
 * glossary.io links' keepDates option: a link-only edit this part publishes
 * itself doesn't move the entry's updated date.
 *
 * EmDash's draft save and its publish each set `updated_at` to now and add 1
 * to `version`, and the plugin content API can't set `updated_at`. So right
 * after its own publish the part puts the date back in D1, with one guarded
 * statement that matches only the row that publish left.
 */

const COLLECTION = /^[a-z][a-z0-9_]*$/;

export interface PublishedRow {
	/** The entry's updated_at as the publish left it. */
	updatedAt: string;
	/** Its version as the publish left it. */
	version: number;
	/** The revision the publish made live, or null for a collection without revisions (its edit is one update). */
	liveRevisionId: string | null;
}

/**
 * Put an entry's updated_at back after this part's own publish. Only when the
 * row is exactly what that publish left: same updated_at, same version, the
 * published revision live, no draft, not trashed. Any save since then changes
 * updated_at and version, so a real edit is never erased. `version` stays as
 * the publish set it, so an editor's open tab still sees that the entry
 * changed. Returns whether the row was changed.
 */
export async function restoreUpdatedAt(db: D1Database, collection: string, id: string, original: string, after: PublishedRow): Promise<boolean> {
	if (!COLLECTION.test(collection)) throw new Error(`keepDates: "${collection}" isn't a collection slug`);
	if (!original || original === after.updatedAt || !Number.isInteger(after.version)) return false;
	const statement =
		after.liveRevisionId === null
			? db
					.prepare(`UPDATE "ec_${collection}" SET updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL AND status = 'published' AND updated_at = ?3 AND version = ?4 AND draft_revision_id IS NULL`)
					.bind(original, id, after.updatedAt, after.version)
			: db
					.prepare(`UPDATE "ec_${collection}" SET updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL AND status = 'published' AND updated_at = ?3 AND version = ?4 AND live_revision_id = ?5 AND draft_revision_id IS NULL`)
					.bind(original, id, after.updatedAt, after.version, after.liveRevisionId);
	const result = await statement.run();
	return Number(result.meta?.changes ?? 0) > 0;
}

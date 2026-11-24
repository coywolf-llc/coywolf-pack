/**
 * glossary.io links' keepDates option: a link-only edit this part publishes
 * itself doesn't move the entry's updated date.
 *
 * In EmDash 1.5.0 a publish sets `updated_at` to now and adds 1 to `version`.
 * A draft save of content alone (a collection with revisions) adds 1 to
 * `version` and sets `draft_revision_id`, and leaves `updated_at` as it is;
 * without revisions, the update itself sets `updated_at` and adds 1 to
 * `version`. The plugin content API can't set `updated_at`. So right after its
 * own write the part puts the date back in D1, with one guarded statement that
 * matches only the row that write left, as EmDash returned it (the publish's
 * `{ item }`, or the update's `updatedAt` with the version read before it
 * plus 1). The row is never read again in between, so a save that lands after
 * the part's write is never mistaken for it.
 */

const COLLECTION = /^[a-z][a-z0-9_]*$/;

export interface PublishedRow {
	/** The entry's updated_at as the part's write left it. */
	updatedAt: string;
	/** Its version as that write left it. */
	version: number;
	/** The revision the publish made live, or null for a collection without revisions (its edit is one update). */
	liveRevisionId: string | null;
}

/**
 * Put an entry's updated_at back after this part's own write. Only when the
 * row is exactly what that write left: same updated_at, same version, the
 * published revision live, no draft, not trashed. Every save since then adds
 * 1 to version (a draft save also sets draft_revision_id), so a real edit is
 * never erased. `version` stays as the write set it, so an editor's open tab
 * still sees that the entry changed. Returns whether the row was changed.
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

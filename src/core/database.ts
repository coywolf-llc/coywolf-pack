/**
 * The site's D1 database, for code that reads or writes EmDash's tables
 * directly (Child Pages, glossary.io links' keepDates and gone-term checks).
 */
import { workerEnv } from "../shared.js";
import type { UrlSource } from "./content-url.js";

const isD1 = (source: UrlSource): source is D1Database => typeof (source as D1Database).prepare === "function";

/** The site's D1 database: the source when it is one, else the DB binding. */
export async function databaseFor(source?: UrlSource | null): Promise<D1Database | null> {
	if (source && isD1(source)) return source;
	try {
		return ((await workerEnv()).DB as D1Database | undefined) ?? null;
	} catch {
		return null;
	}
}

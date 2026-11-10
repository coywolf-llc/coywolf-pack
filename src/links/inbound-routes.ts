/**
 * Link Manager's Entries view: routes for the inbound link counts and
 * orphans (./inbound.ts), behind the "Inbound links and orphans" part.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { requireFeature } from "../core/features.js";
import { readOnlyRoute } from "../core/routes.js";
import { parseInput, workerEnv } from "../shared.js";
import { inboundReport, relatedEntries } from "./inbound.js";
import { getScan } from "./store.js";

export const INBOUND_FEATURE = "links.inbound";

async function database(): Promise<D1Database> {
	const db = ((await workerEnv().catch(() => ({}))) as Record<string, unknown>).DB as D1Database | undefined;
	if (!db?.prepare) throw PluginRouteError.badRequest("Inbound link counts read the site's D1 database (bound as DB), which this site doesn't have.");
	return db;
}

export function inboundRoutes() {
	return {
		/** Every published entry with its inbound internal link count (the page sorts and filters). */
		"links/entries": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, INBOUND_FEATURE);
					const siteUrl = (ctx as PluginContext).site?.url ?? "";
					const scan = await getScan(ctx as PluginContext);
					if (!siteUrl) return { siteUrlKnown: false, scannedAt: scan?.finishedAt ?? null, entries: [], matched: 0, unmatched: 0, builtAt: new Date().toISOString() };
					const report = await inboundReport(await database(), siteUrl);
					return { siteUrlKnown: true, scannedAt: scan?.finishedAt ?? null, scanning: scan?.status === "running", ...report };
				},
			}),
		),

		/** Entries that share categories or tags with each orphan asked about: where to add a link to it from. */
		"links/related": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, INBOUND_FEATURE);
					const input = parseInput(
						z.object({ entries: z.array(z.object({ collection: z.string().max(64), id: z.string().max(128) })).max(50) }),
						ctx.input,
					);
					const related = await relatedEntries(await database(), input.entries);
					return { related: Object.fromEntries(related) };
				},
			}),
		),
	};
}

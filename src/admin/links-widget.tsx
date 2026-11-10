/**
 * The Link Manager dashboard widget. Its own file, so the dashboard doesn't
 * load the Link Manager page.
 */
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { PACK_API, errorText } from "./api.js";
import type { LinkStatus, ScanState } from "./links.js";
import { Loading, PackLink } from "./page.js";

const API = `${PACK_API}/links`;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function LinksWidget() {
	const [data, setData] = React.useState<{ counts: Record<LinkStatus, number>; scan: ScanState }>();
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		apiFetch(`${API}/summary`)
			.then((r) => parseApiResponse<{ counts: Record<LinkStatus, number>; scan: ScanState }>(r, "Could not load links"))
			.then(setData)
			.catch((cause) => setError(errorText(cause, "Could not load links")));
	}, []);
	if (error) return <p className="text-sm text-kumo-subtle">{error}</p>;
	if (!data) return <Loading className="" label="Loading links…" />;
	const problems = data.counts.broken + data.counts.error;
	const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
	return (
		<div className="space-y-1 text-sm">
			<p className={problems ? "font-medium text-kumo-danger" : "font-medium"}>{problems ? `${plural(problems, "broken link")}` : "No broken links"}</p>
			<p className="text-kumo-subtle">
				{plural(total, "link")} · {data.counts.blocked.toLocaleString()} blocked · {data.counts.redirect.toLocaleString()} redirected
				{data.counts.unchecked ? ` · ${data.counts.unchecked.toLocaleString()} not checked` : ""}
			</p>
			<PackLink page="/links" className="text-kumo-link hover:underline">
				Open Link Manager
			</PackLink>
		</div>
	);
}

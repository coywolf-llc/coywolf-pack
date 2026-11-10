/**
 * Step-by-step guides for getting the API keys and tokens some features need,
 * shown next to each credential field in a native <details> (closed until
 * opened). The text lives in src/core/guide-content.ts, which EmDash's generic
 * Settings page uses too (through src/core/settings-enhance.ts).
 */
import * as React from "react";

import { GUIDES, type GuideId, guideHtml } from "../core/guide-content.js";

export type { GuideId };

/** A guide in a closed <details>, using the browser's own disclosure triangle. */
export function CredentialGuide({ id }: { id: GuideId }) {
	// Static, trusted HTML written in guide-content.ts (no user data).
	// dangerouslySetInnerHTML: trusted constant markup.
	return <div dangerouslySetInnerHTML={{ __html: guideHtml(GUIDES[id]) }} />;
}

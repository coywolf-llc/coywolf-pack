/**
 * The Features page's Cloudflare API token card: whether the one token is
 * there, which older tokens are still saved, and removing them once it's
 * saved on Settings (cloudflare-token/status and cloudflare-token/clear-older,
 * src/core/cloudflare-token-routes.ts, which checks the token with Cloudflare
 * first). Removing the File Downloads R2 key pair is a separate box to tick.
 */
import { Banner, Button, Checkbox } from "@cloudflare/kumo";
import * as React from "react";

import { PACK_API, apiGet, apiPost, errorText } from "./api.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { AdminLink } from "./page.js";
import { SETTINGS_PAGE_PATH } from "./settings-ui.js";
import { useToast } from "./toast.js";

interface TokenStatus {
	saved: boolean;
	unreadable: boolean;
	env: boolean;
	accountId: string | null;
	older: Array<{ key: string; label: string; page: string }>;
	/** A complete R2 key pair: large uploads use it ahead of the token. */
	r2KeyPair: boolean;
	/** Part of an R2 key pair, which nothing uses. */
	r2Leftovers: boolean;
	r2Page: string;
	olderSecrets: string[];
}

const get = apiGet(`${PACK_API}/cloudflare-token`);
const post = apiPost(`${PACK_API}/cloudflare-token`);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What large uploads use while only part of an R2 key pair is saved (r2Config in src/files/module.ts): the saved
 * token; when it can't be read, the CLOUDFLARE_API_TOKEN Worker secret if it's set, else nothing until it's saved again.
 */
function leftoverUploads(status: Pick<TokenStatus, "saved" | "unreadable" | "env">): string {
	if (status.saved) return "large uploads use the Cloudflare API token.";
	if (status.unreadable) {
		return status.env
			? "large uploads use the CLOUDFLARE_API_TOKEN Worker secret, since the saved token can't be read."
			: "large uploads need the Cloudflare API token saved again (the saved one can't be read), or a complete key pair.";
	}
	return status.env ? "large uploads use the Cloudflare API token." : "large uploads need a complete key pair or the Cloudflare API token.";
}

export function CloudflareTokenCard() {
	const toast = useToast();
	const [status, setStatus] = React.useState<TokenStatus>();
	const [error, setError] = React.useState<string>();
	const [asking, setAsking] = React.useState(false);
	const [r2, setR2] = React.useState(false);
	const [pending, setPending] = React.useState(false);
	const [removeError, setRemoveError] = React.useState<string | null>(null);

	React.useEffect(() => {
		get<TokenStatus>("status", "Couldn't read the Cloudflare API token's status")
			.then(setStatus)
			.catch((cause) => setError(errorText(cause, "Couldn't read the Cloudflare API token's status")));
	}, []);

	if (error) return <Banner variant="error" role="alert" title="Cloudflare API token" description={error} />;
	if (!status) return null;

	// Only the token saved on Settings replaces older tokens: the Worker secret ranks below them.
	const anyR2 = status.r2KeyPair || status.r2Leftovers;
	const removable = status.saved && (status.older.length > 0 || anyR2);
	const ask = () => {
		// A complete pair is in use, so removing it with the tokens is a choice to make; leftovers aren't used by anything.
		setR2(status.older.length === 0 || status.r2Leftovers);
		setRemoveError(null);
		setAsking(true);
	};
	const remove = async () => {
		setPending(true);
		setRemoveError(null);
		try {
			const result = await post<{ removed: number; status: TokenStatus }>("clear-older", { r2 });
			setStatus(result.status);
			setAsking(false);
			toast.success(`Removed ${plural(result.removed, "older value", "older values")}`, "Every Cloudflare feature now uses the Cloudflare API token.");
		} catch (cause) {
			setRemoveError(errorText(cause, tokens ? "Couldn't remove the older tokens" : "Couldn't remove the R2 key pair values"));
		} finally {
			setPending(false);
		}
	};
	const r2Item = status.r2KeyPair
		? { key: "r2", label: "File Downloads R2 key pair", note: `used by ${status.r2Page}` }
		: { key: "r2", label: "Leftover File Downloads R2 key pair values", note: "not used by anything" };
	const removing = [...status.older.map((o) => ({ key: o.key, label: o.label, note: `used by ${o.page}` })), ...(r2 && anyR2 ? [r2Item] : [])];
	const tokens = status.older.length > 0;
	const dialog = tokens
		? {
				title: "Remove the older tokens?",
				description:
					"First open each page below and check it works with the Cloudflare API token. The pack then checks the token with Cloudflare before it removes anything. This can't be undone here: to go back, paste the older tokens again. The tokens themselves stay in Cloudflare until you delete them there.",
			}
		: status.r2KeyPair
			? {
					title: "Remove the R2 key pair?",
					description:
						"Large uploads then make their R2 keys from the Cloudflare API token, which needs Workers R2 Storage → Edit. The pack checks the token with Cloudflare before it removes anything. This can't be undone here: to go back, enter the key pair again on the Files page → Settings → Advanced. The key pair itself stays in Cloudflare until you delete it there.",
				}
			: {
					title: "Remove the leftover R2 key pair values?",
					description:
						"Part of an older R2 key pair is still saved (an access key ID or a secret without the rest). It isn't used, so nothing changes: large uploads already use the Cloudflare API token. The pack checks the token with Cloudflare before it removes anything. The R2 account ID and bucket name are kept.",
				};

	return (
		<section className="space-y-3 rounded-lg border border-kumo-line p-4" aria-labelledby="cw-cloudflare-token">
			<div>
				<h2 id="cw-cloudflare-token" className="text-base font-semibold">
					Cloudflare API token
				</h2>
				<p className="mt-1 text-sm text-kumo-subtle">
					{status.saved ? (
						<>Saved on the plugin's Settings page. Every Cloudflare feature uses it.</>
					) : status.env ? (
						<>
							From the CLOUDFLARE_API_TOKEN Worker secret. Features with an older token still saved use that one first; save the token on the plugin's{" "}
							<AdminLink to={SETTINGS_PAGE_PATH} className="text-kumo-link underline">
								Settings page
							</AdminLink>{" "}
							to replace them.
						</>
					) : (
						<>
							Not set. One token covers every Cloudflare feature: add it on the plugin's{" "}
							<AdminLink to={SETTINGS_PAGE_PATH} className="text-kumo-link underline">
								Settings page
							</AdminLink>
							.
						</>
					)}
					{(status.saved || status.env) && status.accountId ? ` Account ${status.accountId}.` : ""}
				</p>
			</div>
			{status.unreadable && (
				<Banner
					variant="error"
					description="The saved Cloudflare API token can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed. Save it again on the plugin's Settings page."
				/>
			)}
			{status.older.length > 0 && (
				<p className="text-sm">
					{plural(status.older.length, "older token is", "older tokens are")} still saved: {status.older.map((o) => o.label).join(", ")}.{" "}
					{status.saved ? "The Cloudflare API token replaces them." : "They're what the features use until the Cloudflare API token is saved on Settings."}
				</p>
			)}
			{status.r2KeyPair && <p className="text-sm text-kumo-subtle">File Downloads has an R2 key pair saved. It wins over the token for large uploads.</p>}
			{status.r2Leftovers && (
				<p className="text-sm text-kumo-subtle">Part of an older File Downloads R2 key pair is still saved. It isn't used: {leftoverUploads(status)}</p>
			)}
			{removable && (
				<Button variant="secondary" disabled={pending} onClick={ask}>
					{tokens ? `Remove ${plural(status.older.length, "older token", "older tokens")}` : status.r2KeyPair ? "Remove the R2 key pair" : "Remove the leftover R2 key pair values"}
				</Button>
			)}
			{status.olderSecrets.length > 0 && (
				<p className="text-xs text-kumo-subtle">
					Older Worker secrets are still set: {status.olderSecrets.join(", ")}. Once the Cloudflare API token works, delete each with{" "}
					<code>npx wrangler secret delete NAME</code>.
				</p>
			)}

			<ConfirmDialog
				open={asking}
				onClose={() => !pending && setAsking(false)}
				title={dialog.title}
				description={dialog.description}
				confirmLabel="Remove"
				pendingLabel="Checking and removing…"
				isPending={pending}
				confirmDisabled={removing.length === 0}
				error={removeError}
				onConfirm={() => void remove()}
			>
				{removing.length > 0 && (
					<ul className="space-y-1 text-sm" role="list">
						{removing.map((o) => (
							<li key={o.key}>
								<strong className="font-medium">{o.label}</strong>, {o.note}
							</li>
						))}
					</ul>
				)}
				{anyR2 && tokens && (
					<Checkbox
						label={
							status.r2KeyPair
								? "Also remove the File Downloads R2 key pair (large uploads then use the Cloudflare API token)"
								: "Also remove the leftover File Downloads R2 key pair values (they aren't used: large uploads already use the Cloudflare API token)"
						}
						checked={r2}
						disabled={pending}
						onCheckedChange={(checked: boolean) => setR2(checked)}
					/>
				)}
			</ConfirmDialog>
		</section>
	);
}

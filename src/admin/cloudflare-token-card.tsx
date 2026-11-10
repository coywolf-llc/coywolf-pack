/**
 * The Features page's Cloudflare API token card: whether the one token is
 * there, which older tokens are still saved, and removing them once it is
 * (cloudflare-token/status and cloudflare-token/clear-older,
 * src/core/cloudflare-token-routes.ts). Removing the File Downloads R2 key
 * pair is a separate box to tick.
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
	older: Array<{ key: string; label: string }>;
	r2KeyPair: boolean;
	olderSecrets: string[];
}

const get = apiGet(`${PACK_API}/cloudflare-token`);
const post = apiPost(`${PACK_API}/cloudflare-token`);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

	const hasToken = status.saved || status.env;
	const removable = hasToken && (status.older.length > 0 || status.r2KeyPair);
	const ask = () => {
		setR2(status.older.length === 0);
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
			setRemoveError(errorText(cause, "Couldn't remove the older tokens"));
		} finally {
			setPending(false);
		}
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
						<>From the CLOUDFLARE_API_TOKEN Worker secret. Features with an older token still saved use that one first.</>
					) : (
						<>
							Not set. One token covers every Cloudflare feature: add it on the plugin's{" "}
							<AdminLink to={SETTINGS_PAGE_PATH} className="text-kumo-link underline">
								Settings page
							</AdminLink>
							.
						</>
					)}
					{hasToken && status.accountId ? ` Account ${status.accountId}.` : ""}
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
					{hasToken ? "The Cloudflare API token replaces them." : "They're what the features use until the Cloudflare API token is saved."}
				</p>
			)}
			{status.r2KeyPair && <p className="text-sm text-kumo-subtle">File Downloads has an R2 key pair saved. It wins over the token for large uploads.</p>}
			{removable && (
				<Button variant="secondary" disabled={pending} onClick={ask}>
					{status.older.length ? `Remove ${plural(status.older.length, "older token", "older tokens")}` : "Remove the R2 key pair"}
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
				title="Remove the older tokens?"
				description="Every Cloudflare feature then uses the Cloudflare API token. This can't be undone here: to go back, paste the older tokens again. The tokens themselves stay in Cloudflare until you delete them there."
				confirmLabel="Remove"
				pendingLabel="Removing…"
				isPending={pending}
				confirmDisabled={!status.older.length && !r2}
				error={removeError}
				onConfirm={() => void remove()}
			>
				{status.older.length > 0 && <p className="text-sm">Removes: {status.older.map((o) => o.label).join(", ")}.</p>}
				{status.r2KeyPair && (
					<Checkbox
						label="Also remove the File Downloads R2 key pair (large uploads then use the Cloudflare API token)"
						checked={r2}
						disabled={pending}
						onCheckedChange={(checked: boolean) => setR2(checked)}
					/>
				)}
			</ConfirmDialog>
		</section>
	);
}

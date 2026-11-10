/**
 * Reviews page: the review box's accent color and custom CSS, with a live
 * preview of a sample review (rendered by the same code as the site).
 * Turning Reviews on or off happens on the Features page.
 */
import { Banner, Button, Input, InputArea } from "@cloudflare/kumo";
import { ArrowCounterClockwise, FloppyDisk } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { apiPost, errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { SaveBar } from "./save-bar.js";
import { DEFAULT_ACCENT, MAX_CUSTOM_CSS, SAMPLE_REVIEW, isAccent, pageCss, renderReviewHtml, sanitizeCustomCss } from "../reviews/lib.js";
import { PartSwitches } from "./feature-switches.js";
import { useSaveResult } from "./toast.js";

const API = "/_emdash/api/plugins/coywolf-pack";

const post = apiPost(API);

interface Style {
	accent: string;
	css: string;
}

const EXAMPLE_CSS = `/* Target .cw-review … so rules only reach review boxes. */
.cw-review {
  --cw-review-accent: #b22d47;
  --cw-review-column-min: 100%; /* one column */
}`;

/** The sample review in an isolated frame, so custom CSS can't restyle this admin page. */
function Preview({ style, width }: { style: Style; width: "wide" | "phone" }) {
	const frame = React.useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = React.useState(320);
	const doc = React.useMemo(() => {
		const css = pageCss({ accent: isAccent(style.accent) ? style.accent : DEFAULT_ACCENT, css: sanitizeCustomCss(style.css) });
		return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark}body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;background:Canvas;color:CanvasText}</style><style>${css}</style></head><body>${renderReviewHtml(SAMPLE_REVIEW)}</body></html>`;
	}, [style.accent, style.css]);
	const measure = () => {
		const body = frame.current?.contentDocument?.documentElement;
		if (body) setHeight(Math.min(1200, Math.max(120, body.scrollHeight)));
	};
	return (
		<iframe
			ref={frame}
			title="Review box preview"
			// No scripts; same origin only so the frame's height can be measured.
			sandbox="allow-same-origin"
			srcDoc={doc}
			onLoad={measure}
			className="block rounded-lg border border-kumo-line bg-white"
			style={{ width: width === "phone" ? 375 : "100%", maxWidth: "100%", height }}
		/>
	);
}

export function ReviewsPage() {
	const [saved, setSaved] = React.useState<{ style: Style } | null>(null);
	const [style, setStyle] = React.useState<Style>({ accent: DEFAULT_ACCENT, css: "" });
	const [width, setWidth] = React.useState<"wide" | "phone">("wide");
	const [error, setError] = React.useState<string | null>(null);
	const result = useSaveResult();
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		void (async () => {
			try {
				const settings = await apiFetch(`${API}/reviews/settings`).then((r) => parseApiResponse<Style>(r, "Couldn't load settings"));
				const loaded = { accent: settings.accent, css: settings.css };
				setStyle(loaded);
				setSaved({ style: loaded });
			} catch (cause) {
				setError(errorText(cause, "Couldn't load settings"));
			}
		})();
	}, []);

	const styleDirty = saved !== null && (style.accent !== saved.style.accent || style.css !== saved.style.css);
	const dirty = styleDirty;
	const accentValid = isAccent(style.accent);
	const tooLong = style.css.length > MAX_CUSTOM_CSS;

	async function save() {
		if (!saved || !accentValid || tooLong) return;
		setSaving(true);
		setError(null);
		result.clear();
		try {
			let next = style;
			if (styleDirty) next = await post<Style>("reviews/save", style, "Couldn't save the style");
			setStyle(next);
			setSaved({ style: next });
			result.saved("Settings saved", "The site picks up changes within a minute.");
		} catch (cause) {
			result.failed(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-6">
			<PageHeader
				title="Reviews"
				actions={
					<>
						<Button variant="primary" icon={<FloppyDisk />} disabled={!dirty || saving || !accentValid || tooLong} onClick={() => void save()}>
							Save
						</Button>
					</>
				}
				description={
					<>
						Add a review to an entry with the Coywolf Review block: a rating badge, what you liked most, and what could be better.
						The box is styled with plain CSS sent only on pages with a review; no script.
					</>
				}
			/>

			<PartSwitches module="reviews" />

			{error && <Banner variant="error" role="alert" description={error} />}

			{!saved && !error && (
				<Loading />
			)}

			{saved && (
				<div className="grid gap-6 cw-lg-cols-24-fill">
					<div className="space-y-6">
						<div className="space-y-2">
							<div className="flex items-end gap-2">
								<input
									type="color"
									aria-label="Pick the accent color"
									value={accentValid && style.accent.length === 7 ? style.accent : DEFAULT_ACCENT}
									onChange={(e) => setStyle((cur) => ({ ...cur, accent: e.target.value }))}
									className="h-9 w-12 shrink-0 cursor-pointer rounded border border-kumo-line bg-transparent p-0.5"
								/>
								<div className="min-w-0 flex-1">
									<Input
										label="Accent color (rating badge)"
										value={style.accent}
										aria-invalid={!accentValid}
										aria-describedby={accentValid ? undefined : "cw-reviews-accent-error"}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStyle((cur) => ({ ...cur, accent: e.target.value.trim() }))}
									/>
								</div>
								<Button
									variant="secondary"
									icon={<ArrowCounterClockwise />}
									disabled={style.accent === DEFAULT_ACCENT}
									onClick={() => setStyle((cur) => ({ ...cur, accent: DEFAULT_ACCENT }))}
								>
									Default
								</Button>
							</div>
							{!accentValid && (
								<p id="cw-reviews-accent-error" className="text-sm text-kumo-danger" role="alert">
									Use a hex color like {DEFAULT_ACCENT}.
								</p>
							)}
							<p className="text-xs text-kumo-subtle">Badge text is white; pick a color dark enough to read it.</p>
						</div>

						<div className="space-y-2">
							<InputArea
								label="Custom CSS"
								rows={10}
								value={style.css}
								placeholder={EXAMPLE_CSS}
								spellCheck={false}
								className="font-mono text-xs"
								aria-invalid={tooLong || undefined}
								aria-describedby="cw-reviews-css-limit"
								onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setStyle((cur) => ({ ...cur, css: e.target.value }))}
							/>
							<p id="cw-reviews-css-limit" className={`text-xs ${tooLong ? "text-kumo-danger" : "text-kumo-subtle"}`}>
								{style.css.length.toLocaleString()} / {MAX_CUSTOM_CSS.toLocaleString()} characters. Added after the built-in styles on pages
								with a review. Start rules with <code>.cw-review</code> and set the <code>--cw-review-*</code> properties (see docs/reviews.md in the Coywolf Pack repository) to
								change colors and layout.
							</p>
						</div>
					</div>

					<section aria-labelledby="cw-review-preview-title" className="min-w-0">
						<div className="mb-2 flex items-center justify-between gap-2">
							<h2 id="cw-review-preview-title" className="text-sm font-medium">
								Preview
							</h2>
							<div className="flex gap-1" role="group" aria-label="Preview width">
								<Button size="sm" variant={width === "wide" ? "primary" : "secondary"} aria-pressed={width === "wide"} onClick={() => setWidth("wide")}>
									Wide
								</Button>
								<Button size="sm" variant={width === "phone" ? "primary" : "secondary"} aria-pressed={width === "phone"} onClick={() => setWidth("phone")}>
									Phone
								</Button>
							</div>
						</div>
						<Preview style={style} width={width} />
						<p className="mt-2 text-xs text-kumo-subtle">
							The preview uses this page's fonts and your computer's light or dark setting. On the site the box uses your theme's fonts
							and text color, and turns dark only if the theme supports dark mode (its color-scheme).
						</p>
					</section>
				</div>
			)}

			<SaveBar
				error={result.error}
				dirty={dirty}
				saving={saving}
				canSave={accentValid && !tooLong}
				onSave={() => void save()}
				onDiscard={() => saved && setStyle(saved.style)}
			/>
		</div>
	);
}

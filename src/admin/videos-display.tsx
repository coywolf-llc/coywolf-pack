/**
 * Videos → Settings: Views & likes and Appearance (Video Manager's settings),
 * with a live preview of the unsaved draft beside them. The preview prints
 * the block's own CSS and markup (src/videos/render.ts).
 */
import { Checkbox, Input, Select } from "@cloudflare/kumo";
import * as React from "react";

import { DISPLAY_DEFAULTS, FONT_WEIGHTS, VIDEO_CSS, VIDEO_PREVIEW_CSS, type VideoDisplay, normalizeDisplay, renderVideoPreviewHtml } from "../videos/render.js";
import { PreviewSection } from "./preview.js";
import { SettingsSection } from "./settings-ui.js";

const NUMBERS = ["radius", "borderWidth", "titleSize", "metaSize"] as const;
type NumberKey = (typeof NUMBERS)[number];

/** The form's copy of the display settings: number fields as typed text. */
export type DisplayDraft = Omit<VideoDisplay, NumberKey> & Record<NumberKey, string>;

export const toDisplayDraft = (d: VideoDisplay): DisplayDraft => ({ ...d, radius: String(d.radius), borderWidth: String(d.borderWidth), titleSize: String(d.titleSize), metaSize: String(d.metaSize) });

/** The draft as settings (anything not a valid number falls back to its default; ranges are clamped). */
export function fromDisplayDraft(draft: DisplayDraft): VideoDisplay {
	const n = (key: NumberKey) => {
		const value = Number.parseFloat(draft[key]);
		return Number.isFinite(value) ? value : DISPLAY_DEFAULTS[key];
	};
	return normalizeDisplay({ ...draft, radius: n("radius"), borderWidth: n("borderWidth"), titleSize: n("titleSize"), metaSize: n("metaSize") });
}

const ALIGN = [
	{ value: "left", label: "Left" },
	{ value: "center", label: "Center" },
	{ value: "right", label: "Right" },
];
const WEIGHTS = [{ value: "default", label: "Default" }, ...FONT_WEIGHTS.map((w) => ({ value: w, label: w }))];

/** A hex color: typed, or picked with the browser's color picker. Empty keeps the default. */
function ColorField(props: { label: string; value: string; placeholder: string; disabled?: boolean; onChange: (value: string) => void }) {
	const swatch = /^#[0-9a-f]{6}$/i.test(props.value) ? props.value : /^#[0-9a-f]{6}$/i.test(props.placeholder) ? props.placeholder : "#000000";
	return (
		<div className="flex items-end gap-2">
			<div className="min-w-0 flex-1">
				<Input
					label={props.label}
					placeholder={props.placeholder}
					value={props.value}
					disabled={props.disabled}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value)}
				/>
			</div>
			<input
				type="color"
				className="h-9 w-10 shrink-0 cursor-pointer rounded border border-kumo-line bg-transparent p-0.5"
				aria-label={`Pick ${props.label.toLowerCase()}`}
				value={swatch}
				disabled={props.disabled}
				onChange={(e) => props.onChange(e.target.value)}
			/>
		</div>
	);
}

function Group(props: { title: string; description?: string; children: React.ReactNode }) {
	return (
		<fieldset className="space-y-3 border-t border-kumo-line pt-4 first:border-t-0 first:pt-0">
			<legend className="text-sm font-semibold">{props.title}</legend>
			{props.description && <p className="text-sm text-kumo-subtle">{props.description}</p>}
			{props.children}
		</fieldset>
	);
}

export function DisplaySettings(props: {
	draft: DisplayDraft;
	background: string;
	disabled?: boolean;
	onChange: (patch: Partial<DisplayDraft>) => void;
	onBackground: (value: string) => void;
}) {
	const { draft, disabled, onChange: set } = props;
	const check = (key: "showPlays" | "showLikes" | "showLikeCount" | "showDate" | "showName" | "showDescription" | "followSiteDefaults" | "border", label: string) => (
		<Checkbox label={label} checked={draft[key]} disabled={disabled} onCheckedChange={(checked: boolean) => set({ [key]: checked })} />
	);
	const color = (key: "titleColor" | "likeColor" | "likeBg" | "likeActiveColor" | "likeActiveBg" | "metaColor" | "borderColor", label: string, placeholder: string) => (
		<ColorField label={label} placeholder={placeholder} value={draft[key]} disabled={disabled} onChange={(value) => set({ [key]: value })} />
	);
	const number = (key: NumberKey, label: string, attrs: { min: number; max: number; step: number }, description?: string) => (
		<Input
			type="number"
			label={label}
			description={description}
			{...attrs}
			value={draft[key]}
			disabled={disabled}
			onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ [key]: e.target.value })}
		/>
	);
	const html = renderVideoPreviewHtml(fromDisplayDraft(draft), /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(props.background.trim()) ? props.background.trim() : null);

	return (
		<div className="grid gap-6 cw-lg-cols-fill-24">
			<div className="min-w-0 space-y-6">
				<SettingsSection
					id="videos-engagement"
					title="Views & likes"
					description="What shows beneath each video. Each Coywolf Video block can override these (Show or Hide); blocks left on Site default follow them. Views and likes also need Plays and likes turned on under Plugins → Coywolf Pack."
				>
					<div className="grid gap-2">
						{check("showPlays", "Show the number of views")}
						{check("showLikes", "Show a like button")}
						{check("showLikeCount", "Show the number of likes")}
						{check("showDate", "Show the date the video was uploaded")}
					</div>
					<Select
						label="Date style"
						value={draft.dateStyle}
						disabled={disabled}
						onValueChange={(value: string | null) => set({ dateStyle: value === "relative" ? "relative" : "absolute" })}
						items={[
							{ value: "absolute", label: "Date (Oct 6, 2026)" },
							{ value: "relative", label: "Time ago (7 months ago)" },
						]}
					/>
					<p className="text-sm text-kumo-subtle">
						The view count and upload date are always included in the video schema and sitemap, even when hidden here.
					</p>
					<div className="rounded-md bg-kumo-tint/50 p-3">
						{check("followSiteDefaults", "Make all video blocks follow the site defaults")}
						<p className="mt-1 cw-ps-6 text-sm text-kumo-subtle">
							Blocks added before these settings existed, and blocks imported from WordPress before this version, saved their own on/off choices for the
							name, description, views, likes and date. Turn this on to ignore those older choices so they follow the settings here. Blocks set to Show or
							Hide still override.
						</p>
					</div>
				</SettingsSection>

				<SettingsSection
					id="videos-appearance"
					title="Appearance"
					description="Style the video name, like button, and views and date shown beneath each video. Leave a color empty to keep the default; the preview updates as you change things."
				>
					<Group title="Color scheme">
						<Select
							label="Color scheme"
							value={draft.scheme}
							disabled={disabled}
							onValueChange={(value: string | null) => set({ scheme: value === "light" || value === "dark" || value === "off" ? value : "auto" })}
							items={[
								{ value: "auto", label: "Auto — follow the visitor's system" },
								{ value: "light", label: "Always light" },
								{ value: "dark", label: "Always dark" },
								{ value: "off", label: "Off — use the theme's text color" },
							]}
						/>
						<p className="text-sm text-kumo-subtle">Light and dark set the gray text and the like color for light or dark pages. Any color you set below overrides the scheme.</p>
					</Group>
					<Group title="Alignment" description="Your theme's CSS can also align these; it wins over this setting.">
						<div className="grid gap-4 sm:grid-cols-2">
							<Select label="Name & description" value={draft.align} disabled={disabled} onValueChange={(value: string | null) => set({ align: value === "center" || value === "right" ? value : "left" })} items={ALIGN} />
							<Select
								label="Like / views / date row"
								value={draft.metaAlign}
								disabled={disabled}
								onValueChange={(value: string | null) => set({ metaAlign: value === "center" || value === "right" ? value : "left" })}
								items={ALIGN}
							/>
						</div>
					</Group>
					<Group title="Player">
						<div className="grid gap-4 sm:grid-cols-2">
							{number("radius", "Corner radius (px)", { min: 0, max: 48, step: 1 }, "0 is square corners. GIF-style videos stay square unless you change this.")}
							<ColorField label="Background color" placeholder="transparent" value={props.background} disabled={disabled} onChange={props.onBackground} />
						</div>
						<p className="text-sm text-kumo-subtle">The background shows behind the player, including the letterboxing around videos that don't fill the frame. Empty is transparent.</p>
						{check("border", "Add a border around the player")}
						{draft.border && (
							<div className="grid gap-4 sm:grid-cols-2">
								{number("borderWidth", "Border width (px)", { min: 0, max: 20, step: 1 })}
								{color("borderColor", "Border color", "#eeeeee")}
							</div>
						)}
					</Group>
					<Group title="Name & description" description="The description comes from the block, or the video's Edit dialog.">
						<div className="grid gap-2">
							{check("showName", "Show the video name")}
							{check("showDescription", "Show the video description")}
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							{color("titleColor", "Text color", "inherit")}
							{number("titleSize", "Font size (em)", { min: 0.5, max: 4, step: 0.05 })}
							<Select
								label="Name font weight"
								value={draft.titleWeight || "default"}
								disabled={disabled}
								onValueChange={(value: string | null) => set({ titleWeight: value && value !== "default" ? value : "" })}
								items={WEIGHTS}
							/>
							<Select
								label="Description font weight"
								value={draft.descWeight || "default"}
								disabled={disabled}
								onValueChange={(value: string | null) => set({ descWeight: value && value !== "default" ? value : "" })}
								items={WEIGHTS}
							/>
						</div>
					</Group>
					<Group
						title="Like button"
						description="When unclicked, hovering previews the clicked colors; when clicked, hovering previews the unclicked colors. Leave the clicked colors empty for the default red (and the unclicked background)."
					>
						<Select
							label="Icon"
							value={draft.likeIcon}
							disabled={disabled}
							onValueChange={(value: string | null) => set({ likeIcon: value === "thumbs" || value === "star" ? value : "heart" })}
							items={[
								{ value: "heart", label: "Heart" },
								{ value: "thumbs", label: "Thumbs up" },
								{ value: "star", label: "Star" },
							]}
						/>
						<div className="grid gap-4 sm:grid-cols-2">
							{color("likeColor", "Unclicked color", "inherit")}
							{color("likeBg", "Unclicked background color", "none")}
							{color("likeActiveColor", "Clicked color", "#d1242f")}
							{color("likeActiveBg", "Clicked background color", "none")}
						</div>
					</Group>
					<Group title="Views & date text">
						<div className="grid gap-4 sm:grid-cols-2">
							{color("metaColor", "Text color", "#57606a")}
							{number("metaSize", "Font size (em)", { min: 0.5, max: 4, step: 0.05 })}
						</div>
					</Group>
				</SettingsSection>
			</div>
			<div className="min-w-0 cw-lg-sticky">
				<PreviewSection
					id="videos-display-preview"
					title="Video preview"
					css={`${VIDEO_CSS}\n${VIDEO_PREVIEW_CSS}`}
					html={html}
					note="A sample video with these settings. Hover the like button to see its hover colors. Your theme's fonts and CSS also apply on the site."
				/>
			</div>
		</div>
	);
}

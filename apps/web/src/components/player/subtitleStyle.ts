import type { components } from "@app/api-client";
import type { CSSProperties } from "react";

type Preferences = components["schemas"]["PlayerPreferencesIO"];

/** How the captions look: the part of the player preferences the player itself saves. */
export type SubtitleStyle = Pick<
  Preferences,
  "subtitle_size" | "subtitle_color" | "subtitle_background" | "subtitle_position"
>;

export const DEFAULT_STYLE: SubtitleStyle = {
  subtitle_size: "medium",
  subtitle_color: "white",
  subtitle_background: "outline",
  subtitle_position: "bottom",
};

/** The caption look out of the saved preferences, so saving it never sends the other choices back. */
export function styleOf(saved: Partial<Preferences> | undefined): SubtitleStyle {
  return {
    subtitle_size: saved?.subtitle_size ?? DEFAULT_STYLE.subtitle_size,
    subtitle_color: saved?.subtitle_color ?? DEFAULT_STYLE.subtitle_color,
    subtitle_background: saved?.subtitle_background ?? DEFAULT_STYLE.subtitle_background,
    subtitle_position: saved?.subtitle_position ?? DEFAULT_STYLE.subtitle_position,
  };
}

export const SIZES = ["small", "medium", "large", "huge"] as const;
export const COLORS = ["white", "yellow", "cyan", "green"] as const;
export const BACKGROUNDS = ["none", "outline", "translucent", "solid"] as const;
export const POSITIONS = ["bottom", "raised", "top"] as const;

const SCALE: Record<SubtitleStyle["subtitle_size"], number> = { small: 0.75, medium: 1, large: 1.35, huge: 1.7 };
// Caption colours, not theme colours: they sit on video, so they stay the same in every theme.
const COLOR: Record<SubtitleStyle["subtitle_color"], string> = {
  white: "#ffffff",
  yellow: "#ffe94d",
  cyan: "#6be6ff",
  green: "#86f59a",
};
const OUTLINE = "0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000, -1px -1px 2px #000";

/** Inline style for one caption line. */
export function cueStyle(style: SubtitleStyle): CSSProperties {
  const background = style.subtitle_background;
  return {
    color: COLOR[style.subtitle_color],
    fontSize: `calc(${SCALE[style.subtitle_size]} * clamp(1rem, 2.4vw, 2.4rem))`,
    textShadow: background === "outline" ? OUTLINE : undefined,
    backgroundColor: background === "solid" ? "#000" : background === "translucent" ? "rgb(0 0 0 / 0.6)" : undefined,
  };
}

/**
 * Where the caption block sits; above the controls while they're showing. `controls` is how much
 * room the controls take at the bottom (the TV player's are taller).
 */
export function blockPosition(position: SubtitleStyle["subtitle_position"], controlsShown: boolean, controls = "9rem"): CSSProperties {
  if (position === "top") return { top: "8%" };
  if (position === "raised") return { bottom: controlsShown ? `max(22%, ${controls})` : "22%" };
  return { bottom: controlsShown ? controls : "6%" };
}

/** A WebVTT cue's text without its markup (<i>, <c.color>, voice tags) and entities. */
export function cueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

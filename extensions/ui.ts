// Shared rendering utilities: colors, icons, token formatting.
// Node-only imports so these stay unit-testable without pi's peer packages.

import type { SegmentId } from "./config.ts";

export interface ThemeLike {
	fg(color: string, text: string): string;
}

// ponytail: single fixed palette; expose config overrides instead of a theme engine
const RAINBOW_COLORS = [
	"#b281d6", "#d787af", "#febc38", "#e4c00f",
	"#89d281", "#00afaf", "#178fb9",
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(color: string): boolean {
	return HEX_COLOR_RE.test(color);
}

export function hexToAnsi(hex: string): string {
	const h = hex.replace("#", "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Apply a #hex or pi theme semantic color to text. */
export function applyColor(theme: ThemeLike, color: string, text: string): string {
	if (isHexColor(color)) {
		return `${hexToAnsi(color)}${text}\x1b[0m`;
	}
	try {
		return theme.fg(color, text);
	} catch {
		// Unknown semantic name: fall back to plain text instead of throwing mid-render.
		return theme.fg("text", text);
	}
}

/** Per-character rainbow gradient (spaces and colons stay uncolored). */
export function rainbow(text: string): string {
	let result = "";
	let colorIndex = 0;
	for (const char of text) {
		if (char === " " || char === ":") {
			result += char;
		} else {
			result += hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]) + char;
			colorIndex += 1;
		}
	}
	return result + "\x1b[0m";
}

export interface IconSet {
	model: string;
	thinking: string;
	path: string;
	git: string;
	context: string;
	tps: string;
	cache_rate: string;
}

export const NERD_ICONS: IconSet = {
	model: "\uEC19",       // chip
	thinking: "\uF06D",    // fire
	path: "\uF07B",        // folder (solid)
	git: "\uF126",         // code fork
	context: "\uF1C0",     // database
	tps: "\uF0E4",         // tachometer
	cache_rate: "\uF140",  // bullseye
};

// ASCII terminals get no icons at all: plain text, like the built-in footer.
export const ASCII_ICONS: IconSet = {
	model: "",
	thinking: "",
	path: "",
	git: "",
	context: "",
	tps: "",
	cache_rate: "",
};

export function hasNerdFonts(): boolean {
	if (process.env.LIGHT_STATUSLINE_NERD_FONTS === "1") return true;
	if (process.env.LIGHT_STATUSLINE_NERD_FONTS === "0") return false;
	// Ghostty survives into tmux via GHOSTTY_RESOURCES_DIR.
	if (process.env.GHOSTTY_RESOURCES_DIR) return true;
	const term = (process.env.TERM_PROGRAM || "").toLowerCase();
	return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((t) => term.includes(t));
}

export function resolveIcons(overrides: Partial<Record<SegmentId, string>>): IconSet {
	const base = hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
	return { ...base, ...overrides };
}

export function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

/** Compact token count formatting: 999 / 1.2k / 12k / 1.2M / 12M. */
export function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

/** Default semantic colors, used when a segment has no user override. */
export const DEFAULT_COLORS: Record<SegmentId, string> = {
	model: "accent",
	thinking: "dim",
	path: "text",
	git: "success",
	context: "dim",
	tps: "#00afaf",
	cache_rate: "#00afaf",
};
